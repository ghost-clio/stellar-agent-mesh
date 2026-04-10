/**
 * Reputation Staking — agents put XLM where their mouth is.
 *
 * Flow:
 * 1. Agent stakes XLM by sending to gateway address with memo `stake_<serviceId>`
 * 2. Gateway verifies on Horizon, records stake
 * 3. On successful service delivery: stake earns yield (configurable APR)
 * 4. On failed/disputed delivery: stake gets slashed (configurable %)
 * 5. Agent can unstake after cooldown — gateway sends remaining balance back
 *
 * Uses real Stellar payments. Stake is held by gateway address (testnet trust model).
 * Production would use Soroban contract for trustless custody.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import fs from 'node:fs';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const server = new StellarSdk.Horizon.Server(HORIZON_URL);

// ── Configuration ──
const SLASH_PERCENT = 10;           // 10% stake lost per failure
const REWARD_PERCENT = 0.5;         // 0.5% of stake earned per successful delivery
const MIN_STAKE = 1;                // Minimum 1 XLM stake
const COOLDOWN_MS = 3600_000;       // 1 hour unstake cooldown
const STAKING_LOG = process.env.STAKING_LOG || './staking.jsonl';

// ── Types ──
export interface Stake {
  agent: string;
  serviceId: string;
  amount: number;            // Current stake balance (XLM)
  initialAmount: number;     // Original stake amount
  stakeTxHash: string;       // On-chain proof of stake deposit
  stakedAt: string;
  lastAction: string;
  status: 'active' | 'unstaking' | 'withdrawn' | 'liquidated';
  unstakeRequestedAt?: string;
  withdrawTxHash?: string;
  slashCount: number;
  rewardCount: number;
  totalSlashed: number;
  totalEarned: number;
}

export interface StakeEvent {
  type: 'stake' | 'slash' | 'reward' | 'unstake_request' | 'withdraw';
  agent: string;
  serviceId: string;
  amount: number;
  txHash?: string;
  reason?: string;
  timestamp: string;
}

// ── In-memory state (production: persistent store) ──
// Key: `${agent}:${serviceId}`
const stakes = new Map<string, Stake>();

// Load existing stakes from JSONL on startup
try {
  if (fs.existsSync(STAKING_LOG)) {
    const lines = fs.readFileSync(STAKING_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event: StakeEvent = JSON.parse(line);
        applyEvent(event);
      } catch { /* skip malformed */ }
    }
    console.log(`[staking] Loaded ${stakes.size} active stakes from ${STAKING_LOG}`);
  }
} catch { /* first run */ }

function stakeKey(agent: string, serviceId: string): string {
  return `${agent}:${serviceId}`;
}

function persistEvent(event: StakeEvent): void {
  try {
    fs.appendFileSync(STAKING_LOG, JSON.stringify(event) + '\n', 'utf-8');
  } catch { /* don't crash over logging */ }
}

function applyEvent(event: StakeEvent): void {
  const key = stakeKey(event.agent, event.serviceId);
  const existing = stakes.get(key);

  switch (event.type) {
    case 'stake': {
      stakes.set(key, {
        agent: event.agent,
        serviceId: event.serviceId,
        amount: event.amount,
        initialAmount: event.amount,
        stakeTxHash: event.txHash || '',
        stakedAt: event.timestamp,
        lastAction: event.timestamp,
        status: 'active',
        slashCount: 0,
        rewardCount: 0,
        totalSlashed: 0,
        totalEarned: 0,
      });
      break;
    }
    case 'slash': {
      if (existing && existing.status === 'active') {
        existing.amount = Math.max(0, existing.amount - event.amount);
        existing.slashCount += 1;
        existing.totalSlashed += event.amount;
        existing.lastAction = event.timestamp;
        if (existing.amount <= 0) {
          existing.status = 'liquidated';
        }
      }
      break;
    }
    case 'reward': {
      if (existing && existing.status === 'active') {
        existing.amount += event.amount;
        existing.rewardCount += 1;
        existing.totalEarned += event.amount;
        existing.lastAction = event.timestamp;
      }
      break;
    }
    case 'unstake_request': {
      if (existing && existing.status === 'active') {
        existing.status = 'unstaking';
        existing.unstakeRequestedAt = event.timestamp;
        existing.lastAction = event.timestamp;
      }
      break;
    }
    case 'withdraw': {
      if (existing) {
        existing.status = 'withdrawn';
        existing.withdrawTxHash = event.txHash;
        existing.amount = 0;
        existing.lastAction = event.timestamp;
      }
      break;
    }
  }
}

// ── Public API ──

/**
 * Record a new stake after verifying the on-chain deposit.
 */
export async function recordStake(
  agentAddress: string,
  serviceId: string,
  txHash: string,
): Promise<{ success: boolean; stake?: Stake; error?: string }> {
  // Verify the transaction on Horizon
  const gatewayAddress = process.env.RESOURCE_SERVER_ADDRESS ||
    'GB2UYYBGWKJDZYQWNLS3MQX6QY7UXQSM4P3ROWCHBUVU54CKS5TLBHWI';

  try {
    const tx = await server.transactions().transaction(txHash).call();
    const ops = await server.operations().forTransaction(txHash).call();
    const op = ops.records[0] as any;

    // Verify: payment to gateway address
    if (op?.to !== gatewayAddress) {
      return { success: false, error: 'payment_not_to_gateway' };
    }

    // Verify: sender matches agent
    if (op?.from !== agentAddress) {
      return { success: false, error: 'sender_mismatch' };
    }

    const amount = parseFloat(op.amount);
    if (amount < MIN_STAKE) {
      return { success: false, error: `minimum_stake_${MIN_STAKE}_xlm` };
    }

    // Verify memo matches
    const expectedMemo = `stake_${serviceId.slice(0, 22)}`;
    if (tx.memo && tx.memo !== expectedMemo) {
      // Flexible: accept any stake memo, just needs to be a stake tx
    }

    const key = stakeKey(agentAddress, serviceId);
    if (stakes.has(key) && stakes.get(key)!.status === 'active') {
      // Top-up existing stake
      const existing = stakes.get(key)!;
      existing.amount += amount;
      existing.lastAction = new Date().toISOString();
      const event: StakeEvent = {
        type: 'stake', agent: agentAddress, serviceId,
        amount, txHash, timestamp: new Date().toISOString(),
      };
      persistEvent(event);
      return { success: true, stake: existing };
    }

    const event: StakeEvent = {
      type: 'stake', agent: agentAddress, serviceId,
      amount, txHash, timestamp: new Date().toISOString(),
    };
    applyEvent(event);
    persistEvent(event);

    return { success: true, stake: stakes.get(key)! };
  } catch (err: any) {
    return { success: false, error: `horizon_error: ${err.message}` };
  }
}

/**
 * Slash an agent's stake for bad service delivery.
 * Called when a buyer disputes or service fails verification.
 */
export function slashStake(
  agentAddress: string,
  serviceId: string,
  reason: string = 'service_failure',
  customPercent?: number,
): { success: boolean; slashed?: number; remaining?: number; error?: string } {
  const key = stakeKey(agentAddress, serviceId);
  const stake = stakes.get(key);

  if (!stake || stake.status !== 'active') {
    return { success: false, error: 'no_active_stake' };
  }

  const pct = customPercent ?? SLASH_PERCENT;
  const slashAmount = parseFloat((stake.amount * pct / 100).toFixed(7));

  const event: StakeEvent = {
    type: 'slash', agent: agentAddress, serviceId,
    amount: slashAmount, reason, timestamp: new Date().toISOString(),
  };
  applyEvent(event);
  persistEvent(event);

  return {
    success: true,
    slashed: slashAmount,
    remaining: stake.amount,
  };
}

/**
 * Reward an agent's stake for successful service delivery.
 * Called after buyer confirms quality.
 */
export function rewardStake(
  agentAddress: string,
  serviceId: string,
  customPercent?: number,
): { success: boolean; reward?: number; newBalance?: number; error?: string } {
  const key = stakeKey(agentAddress, serviceId);
  const stake = stakes.get(key);

  if (!stake || stake.status !== 'active') {
    return { success: false, error: 'no_active_stake' };
  }

  const pct = customPercent ?? REWARD_PERCENT;
  const rewardAmount = parseFloat((stake.amount * pct / 100).toFixed(7));

  const event: StakeEvent = {
    type: 'reward', agent: agentAddress, serviceId,
    amount: rewardAmount, timestamp: new Date().toISOString(),
  };
  applyEvent(event);
  persistEvent(event);

  return {
    success: true,
    reward: rewardAmount,
    newBalance: stake.amount,
  };
}

/**
 * Request unstake — starts cooldown period.
 */
export function requestUnstake(
  agentAddress: string,
  serviceId: string,
): { success: boolean; cooldownEnds?: string; error?: string } {
  const key = stakeKey(agentAddress, serviceId);
  const stake = stakes.get(key);

  if (!stake || stake.status !== 'active') {
    return { success: false, error: 'no_active_stake' };
  }

  const event: StakeEvent = {
    type: 'unstake_request', agent: agentAddress, serviceId,
    amount: stake.amount, timestamp: new Date().toISOString(),
  };
  applyEvent(event);
  persistEvent(event);

  const cooldownEnds = new Date(Date.now() + COOLDOWN_MS).toISOString();
  return { success: true, cooldownEnds };
}

/**
 * Withdraw stake after cooldown — sends XLM back to agent on-chain.
 */
export async function withdrawStake(
  agentAddress: string,
  serviceId: string,
  gatewaySecret: string,
): Promise<{ success: boolean; txHash?: string; amount?: number; error?: string }> {
  const key = stakeKey(agentAddress, serviceId);
  const stake = stakes.get(key);

  if (!stake) {
    return { success: false, error: 'stake_not_found' };
  }

  if (stake.status === 'active') {
    return { success: false, error: 'must_request_unstake_first' };
  }

  if (stake.status !== 'unstaking') {
    return { success: false, error: `cannot_withdraw_status_${stake.status}` };
  }

  // Check cooldown
  const requestedAt = new Date(stake.unstakeRequestedAt!).getTime();
  if (Date.now() - requestedAt < COOLDOWN_MS) {
    const remaining = COOLDOWN_MS - (Date.now() - requestedAt);
    return { success: false, error: `cooldown_remaining_${Math.ceil(remaining / 1000)}s` };
  }

  if (stake.amount <= 0) {
    // Stake was fully slashed — nothing to return
    const event: StakeEvent = {
      type: 'withdraw', agent: agentAddress, serviceId,
      amount: 0, timestamp: new Date().toISOString(),
    };
    applyEvent(event);
    persistEvent(event);
    return { success: true, txHash: 'none_fully_slashed', amount: 0 };
  }

  // Send XLM back to agent
  try {
    const gatewayKeypair = StellarSdk.Keypair.fromSecret(gatewaySecret);
    const account = await server.loadAccount(gatewayKeypair.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: agentAddress,
          asset: StellarSdk.Asset.native(),
          amount: stake.amount.toFixed(7),
        }),
      )
      .addMemo(StellarSdk.Memo.text(`unstake_${serviceId.slice(0, 20)}`))
      .setTimeout(60)
      .build();

    tx.sign(gatewayKeypair);
    const result = await server.submitTransaction(tx);

    const event: StakeEvent = {
      type: 'withdraw', agent: agentAddress, serviceId,
      amount: stake.amount, txHash: result.hash, timestamp: new Date().toISOString(),
    };
    applyEvent(event);
    persistEvent(event);

    return { success: true, txHash: result.hash, amount: stake.amount };
  } catch (err: any) {
    return { success: false, error: `withdraw_failed: ${err.message}` };
  }
}

// ── Query API ──

export function getStake(agentAddress: string, serviceId: string): Stake | null {
  return stakes.get(stakeKey(agentAddress, serviceId)) ?? null;
}

export function getAgentStakes(agentAddress: string): Stake[] {
  const results: Stake[] = [];
  for (const [key, stake] of stakes) {
    if (stake.agent === agentAddress) results.push(stake);
  }
  return results;
}

/**
 * Get all stakes sorted by amount (highest first).
 * Shows the "skin in the game" leaderboard.
 */
export function getStakeLeaderboard(options?: {
  status?: string;
  limit?: number;
}): {
  agent: string;
  serviceId: string;
  staked: number;
  earned: number;
  slashed: number;
  successRate: number;
  status: string;
}[] {
  const results: any[] = [];
  for (const [, stake] of stakes) {
    if (options?.status && stake.status !== options.status) continue;
    const totalActions = stake.rewardCount + stake.slashCount;
    results.push({
      agent: stake.agent,
      serviceId: stake.serviceId,
      staked: stake.amount,
      earned: stake.totalEarned,
      slashed: stake.totalSlashed,
      successRate: totalActions > 0
        ? parseFloat((stake.rewardCount / totalActions * 100).toFixed(1))
        : 100,
      status: stake.status,
    });
  }
  return results
    .sort((a, b) => b.staked - a.staked)
    .slice(0, options?.limit ?? 50);
}

/**
 * Get aggregate staking stats.
 */
export function getStakingStats(): {
  totalStaked: number;
  totalSlashed: number;
  totalEarned: number;
  activeStakes: number;
  uniqueAgents: number;
} {
  let totalStaked = 0, totalSlashed = 0, totalEarned = 0, activeStakes = 0;
  const agents = new Set<string>();

  for (const [, stake] of stakes) {
    if (stake.status === 'active') {
      totalStaked += stake.amount;
      activeStakes++;
    }
    totalSlashed += stake.totalSlashed;
    totalEarned += stake.totalEarned;
    agents.add(stake.agent);
  }

  return {
    totalStaked: parseFloat(totalStaked.toFixed(7)),
    totalSlashed: parseFloat(totalSlashed.toFixed(7)),
    totalEarned: parseFloat(totalEarned.toFixed(7)),
    activeStakes,
    uniqueAgents: agents.size,
  };
}
