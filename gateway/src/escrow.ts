/**
 * Claimable Balance Escrow — pay-on-completion for agent services.
 *
 * Flow:
 * 1. Buyer locks XLM in a claimable balance (time-bounded)
 * 2. Service is delivered
 * 3. Seller claims the balance (or buyer reclaims after timeout)
 *
 * Uses Stellar's native claimable balances — no smart contract needed
 * for the basic escrow. Soroban used optionally for policy verification.
 */

import * as StellarSdk from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === 'mainnet'
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

export interface EscrowResult {
  balanceId: string;
  txHash: string;
  amount: string;
  buyer: string;
  seller: string;
  expiresAt: string;
  memo: string;
}

export interface ClaimResult {
  txHash: string;
  balanceId: string;
  claimedBy: string;
  amount: string;
}

// In-memory escrow tracking (production: persistent store)
const escrows = new Map<string, {
  balanceId: string;
  buyer: string;
  seller: string;
  amount: string;
  serviceId: string;
  status: 'locked' | 'claimed' | 'refunded' | 'expired';
  createdAt: string;
  expiresAt: string;
  txHash: string;
  claimTxHash?: string;
}>();

/**
 * Create an escrow: buyer locks funds in a claimable balance.
 * 
 * Predicates:
 * - Seller can claim ANYTIME (once service is delivered, they claim)
 * - Buyer can reclaim ONLY AFTER timeout (safety net)
 */
export async function createEscrow(
  buyerSecret: string,
  sellerAddress: string,
  amount: string,
  serviceId: string,
  timeoutSeconds: number = 3600, // 1 hour default
): Promise<EscrowResult> {
  const buyerKeypair = StellarSdk.Keypair.fromSecret(buyerSecret);
  const buyerAddress = buyerKeypair.publicKey();
  const account = await server.loadAccount(buyerAddress);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + timeoutSeconds) * 1000).toISOString();
  const memo = `escrow_${serviceId.slice(0, 20)}`;

  // Seller: can claim anytime (unconditional)
  // Buyer: can reclaim only after timeout
  const claimants = [
    new StellarSdk.Claimant(
      sellerAddress,
      StellarSdk.Claimant.predicateUnconditional(),
    ),
    new StellarSdk.Claimant(
      buyerAddress,
      StellarSdk.Claimant.predicateNot(
        StellarSdk.Claimant.predicateBeforeAbsoluteTime(String(now + timeoutSeconds)),
      ),
    ),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.createClaimableBalance({
        asset: StellarSdk.Asset.native(),
        amount,
        claimants,
      }),
    )
    .addMemo(StellarSdk.Memo.text(memo.slice(0, 28)))
    .setTimeout(60)
    .build();

  tx.sign(buyerKeypair);

  const result = await server.submitTransaction(tx);

  // Extract the claimable balance ID from the result
  // It's in the operation result as a balance_id
  const balanceId = extractBalanceId(result);

  const escrow = {
    balanceId,
    buyer: buyerAddress,
    seller: sellerAddress,
    amount,
    serviceId,
    status: 'locked' as const,
    createdAt: new Date().toISOString(),
    expiresAt,
    txHash: result.hash,
  };

  escrows.set(balanceId, escrow);

  return {
    balanceId,
    txHash: result.hash,
    amount,
    buyer: buyerAddress,
    seller: sellerAddress,
    expiresAt,
    memo,
  };
}

/**
 * Seller claims the escrow after delivering the service.
 */
export async function claimEscrow(
  sellerSecret: string,
  balanceId: string,
): Promise<ClaimResult> {
  const sellerKeypair = StellarSdk.Keypair.fromSecret(sellerSecret);
  const sellerAddress = sellerKeypair.publicKey();
  const account = await server.loadAccount(sellerAddress);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.claimClaimableBalance({
        balanceId,
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(sellerKeypair);

  const result = await server.submitTransaction(tx);

  // Update tracking
  const escrow = escrows.get(balanceId);
  if (escrow) {
    escrow.status = 'claimed';
    escrow.claimTxHash = result.hash;
  }

  return {
    txHash: result.hash,
    balanceId,
    claimedBy: sellerAddress,
    amount: escrow?.amount ?? 'unknown',
  };
}

/**
 * Buyer reclaims funds after timeout (service never delivered).
 */
export async function refundEscrow(
  buyerSecret: string,
  balanceId: string,
): Promise<ClaimResult> {
  const buyerKeypair = StellarSdk.Keypair.fromSecret(buyerSecret);
  const buyerAddress = buyerKeypair.publicKey();
  const account = await server.loadAccount(buyerAddress);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.claimClaimableBalance({
        balanceId,
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(buyerKeypair);

  const result = await server.submitTransaction(tx);

  // Update tracking
  const escrow = escrows.get(balanceId);
  if (escrow) {
    escrow.status = 'refunded';
    escrow.claimTxHash = result.hash;
  }

  return {
    txHash: result.hash,
    balanceId,
    claimedBy: buyerAddress,
    amount: escrow?.amount ?? 'unknown',
  };
}

/**
 * Get escrow status
 */
export function getEscrow(balanceId: string) {
  return escrows.get(balanceId) ?? null;
}

/**
 * List all escrows (optionally filtered by buyer or seller)
 */
export function listEscrows(filter?: { buyer?: string; seller?: string; status?: string }) {
  const results: any[] = [];
  for (const [id, escrow] of escrows) {
    if (filter?.buyer && escrow.buyer !== filter.buyer) continue;
    if (filter?.seller && escrow.seller !== filter.seller) continue;
    if (filter?.status && escrow.status !== filter.status) continue;
    results.push({ id, ...escrow });
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Extract claimable balance ID from transaction result.
 * The ID is a hash of the operation result.
 */
function extractBalanceId(result: any): string {
  try {
    // Parse the result XDR to get the balance ID
    const meta = StellarSdk.xdr.TransactionMeta.fromXDR(
      result.result_meta_xdr,
      'base64',
    );
    // Try v3 then v2 for operation results
    let ops: any[] = [];
    try { ops = meta.v3().operations(); } catch {
      try { ops = meta.v2().operations(); } catch { /* fallback below */ }
    }
    for (const op of ops) {
      const changes = op.changes();
      for (const change of changes) {
        if (change.switch().name === 'ledgerEntryCreated') {
          const entry = change.created().data();
          if (entry.switch().name === 'claimableBalance') {
            const balanceIdXdr = entry.claimableBalance().balanceId();
            return balanceIdXdr.toXDR('hex');
          }
        }
      }
    }
    // Fallback: use tx hash as ID
    return result.hash;
  } catch {
    return result.hash;
  }
}
