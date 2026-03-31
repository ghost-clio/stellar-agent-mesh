/**
 * Stellar integration — real testnet transactions via @stellar/stellar-sdk
 * Used for direct payments and verification alongside x402 flow
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
}

/**
 * Submit a real XLM payment on Stellar testnet
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

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);

  return {
    hash: result.hash,
    ledger: result.ledger,
    from: keypair.publicKey(),
    to: destination,
    amount,
    asset: 'XLM',
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
 * Verify a transaction exists on testnet
 */
export async function verifyTransaction(txHash: string): Promise<boolean> {
  try {
    await server.transactions().transaction(txHash).call();
    return true;
  } catch {
    return false;
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

export { server as horizonServer, NETWORK_PASSPHRASE };
