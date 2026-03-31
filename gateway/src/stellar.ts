/**
 * Stellar integration — real testnet transactions via @stellar/stellar-sdk
 * Supports: basic payments, path payments, time-bounded txs, verification
 */

import * as StellarSdk from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

export interface PaymentResult {
  hash: string;
  ledger: number;
  from: string;
  to: string;
  amount: string;
  asset: string;
  type: 'payment' | 'path_payment';
}

/**
 * Submit a real XLM payment on Stellar testnet with time bounds
 */
export async function submitPayment(
  senderSecret: string,
  destination: string,
  amount: string,
  memo?: string
): Promise<PaymentResult> {
  const keypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const account = await server.loadAccount(keypair.publicKey());

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  txBuilder.addOperation(
    StellarSdk.Operation.payment({
      destination,
      asset: StellarSdk.Asset.native(),
      amount,
    })
  );

  if (memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
  }

  // Time bounds: valid for 60 seconds from now (prevents stale/replay)
  const tx = txBuilder.setTimeout(60).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);

  return {
    hash: result.hash,
    ledger: result.ledger,
    from: keypair.publicKey(),
    to: destination,
    amount,
    asset: 'XLM',
    type: 'payment',
  };
}

/**
 * Submit a path payment — buyer pays XLM, seller receives specified asset
 * Uses Stellar DEX for automatic routing
 */
export async function submitPathPayment(
  senderSecret: string,
  destination: string,
  destAsset: StellarSdk.Asset,
  destAmount: string,
  maxSendAmount: string,
  memo?: string
): Promise<PaymentResult> {
  const keypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const account = await server.loadAccount(keypair.publicKey());

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  txBuilder.addOperation(
    StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset: StellarSdk.Asset.native(), // Buyer always pays XLM
      sendMax: maxSendAmount,
      destination,
      destAsset,
      destAmount,
      path: [], // Let Stellar DEX find the path
    })
  );

  if (memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
  }

  const tx = txBuilder.setTimeout(60).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);

  return {
    hash: result.hash,
    ledger: result.ledger,
    from: keypair.publicKey(),
    to: destination,
    amount: destAmount,
    asset: destAsset.isNative() ? 'XLM' : destAsset.getCode(),
    type: 'path_payment',
  };
}

/**
 * Check account balance on testnet
 */
export async function getBalance(address: string): Promise<{ xlm: string; usdc: string }> {
  try {
    const account = await server.loadAccount(address);
    let xlm = '0';
    let usdc = '0';

    for (const balance of account.balances) {
      if (balance.asset_type === 'native') {
        xlm = balance.balance;
      }
      if ('asset_code' in balance && balance.asset_code === 'USDC') {
        usdc = balance.balance;
      }
    }

    return { xlm, usdc };
  } catch {
    return { xlm: '0', usdc: '0' };
  }
}

/**
 * Verify a transaction exists on testnet and extract details.
 * Optionally verify destination and minimum amount.
 */
export async function verifyTransaction(
  txHash: string,
  expectedRecipient?: string,
  expectedMinAmount?: number,
): Promise<{
  verified: boolean;
  from?: string;
  to?: string;
  amount?: string;
  memo?: string;
  createdAt?: string;
}> {
  try {
    const tx = await server.transactions().transaction(txHash).call();
    const ops = await server.operations().forTransaction(txHash).call();
    const op = ops.records[0] as any;

    // Verify destination matches expected recipient
    if (expectedRecipient && op?.to && op.to !== expectedRecipient) {
      return { verified: false };
    }

    // Verify amount meets minimum
    if (expectedMinAmount && op?.amount && parseFloat(op.amount) < expectedMinAmount) {
      return { verified: false };
    }

    return {
      verified: true,
      from: op?.from || tx.source_account,
      to: op?.to,
      amount: op?.amount,
      memo: tx.memo,
      createdAt: tx.created_at,
    };
  } catch {
    return { verified: false };
  }
}

/**
 * Fund an account via Friendbot (testnet only)
 */
export async function fundAccount(address: string): Promise<boolean> {
  try {
    const response = await fetch(`https://friendbot.stellar.org?addr=${address}`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Query available paths between assets via Stellar DEX
 */
export async function findPaymentPaths(
  sourceAddress: string,
  destAddress: string,
  destAsset: StellarSdk.Asset,
  destAmount: string
): Promise<any[]> {
  try {
    const paths = await server
      .strictReceivePaths(sourceAddress, destAsset, destAmount)
      .call();
    return paths.records;
  } catch {
    return [];
  }
}

export { server as horizonServer, NETWORK_PASSPHRASE, StellarSdk };
