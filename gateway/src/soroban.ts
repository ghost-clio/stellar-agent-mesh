/**
 * Soroban contract client — wires gateway to on-chain registry contract.
 * Calls update_reputation after each payment to create verifiable on-chain audit trail.
 */

import * as StellarSdk from '@stellar/stellar-sdk';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.SOROBAN_CONTRACT_ID || '';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === 'mainnet'
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

const rpcServer = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

/**
 * Call update_reputation on the Soroban contract after a payment.
 * This creates a verifiable on-chain record of agent reliability.
 * 
 * Fire-and-forget: gateway doesn't block on this. Payment is already settled
 * via Stellar native ops. This is the audit layer.
 */
export async function recordReputationOnChain(
  signerSecret: string,
  agentAddress: string,
  success: boolean,
): Promise<{ txHash: string } | null> {
  if (!CONTRACT_ID) {
    return null; // No contract configured, skip silently
  }

  try {
    const keypair = StellarSdk.Keypair.fromSecret(signerSecret);
    const account = await rpcServer.getAccount(keypair.publicKey());

    const contract = new StellarSdk.Contract(CONTRACT_ID);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'update_reputation',
          StellarSdk.nativeToScVal(agentAddress, { type: 'address' }),
          StellarSdk.nativeToScVal(success, { type: 'bool' }),
        ),
      )
      .setTimeout(30)
      .build();

    // Simulate first to get the footprint
    const simulated = await rpcServer.simulateTransaction(tx);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      console.error(`[soroban] Simulation failed: ${(simulated as any).error}`);
      return null;
    }

    // Assemble with the simulation result (adds resource footprint)
    const assembled = StellarSdk.rpc.assembleTransaction(tx, simulated).build();
    assembled.sign(keypair);

    // Submit
    const sent = await rpcServer.sendTransaction(assembled);

    if (sent.status === 'ERROR') {
      console.error(`[soroban] Submit failed: ${sent.status}`);
      return null;
    }

    // Poll for confirmation (max 10s)
    let result = await rpcServer.getTransaction(sent.hash);
    let attempts = 0;
    while (result.status === 'NOT_FOUND' && attempts < 10) {
      await new Promise(r => setTimeout(r, 1000));
      result = await rpcServer.getTransaction(sent.hash);
      attempts++;
    }

    if (result.status === 'SUCCESS') {
      console.log(`[soroban] Reputation updated on-chain: ${agentAddress.slice(0, 8)}... success=${success} tx=${sent.hash.slice(0, 12)}...`);
      return { txHash: sent.hash };
    }

    console.warn(`[soroban] Tx status: ${result.status} after ${attempts}s`);
    return null;
  } catch (err: any) {
    // Non-fatal: don't break payments if Soroban is down
    console.error(`[soroban] Error recording reputation: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * Query agent reputation from on-chain contract.
 */
export async function getOnChainReputation(
  agentAddress: string,
): Promise<{ txCount: number; successCount: number } | null> {
  if (!CONTRACT_ID) return null;

  try {
    const contract = new StellarSdk.Contract(CONTRACT_ID);
    const account = new StellarSdk.Account(agentAddress, '0');

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'get_reputation',
          StellarSdk.nativeToScVal(agentAddress, { type: 'address' }),
        ),
      )
      .setTimeout(30)
      .build();

    const simulated = await rpcServer.simulateTransaction(tx);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return null;
    }

    const successSim = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    if (successSim.result) {
      const val = StellarSdk.scValToNative(successSim.result.retval);
      return {
        txCount: Number(val.tx_count ?? val.txCount ?? 0),
        successCount: Number(val.success_count ?? val.successCount ?? 0),
      };
    }

    return null;
  } catch {
    return null;
  }
}
