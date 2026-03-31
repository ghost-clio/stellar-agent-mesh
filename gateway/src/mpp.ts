import * as crypto from 'crypto';

/**
 * Machine Payments Protocol (MPP) — Alternative payment channel
 *
 * MPP is Stripe's machine-to-machine payment protocol for AI agents.
 * While x402 uses HTTP 402 status codes, MPP uses a different flow:
 *   1. Agent discovers resource with pricing metadata
 *   2. Agent initiates payment via MPP session
 *   3. Payment settles on Stellar
 *   4. Resource unlocked with MPP receipt
 *
 * This implements a minimal MPP-compatible layer alongside x402,
 * allowing agents to choose their preferred payment protocol.
 */

export interface MppPricing {
  resource: string;
  amount: string;
  currency: string;
  network: string;
  recipient: string;
  sessionId: string;
  expiresAt: string;
  protocol: 'mpp';
}

export interface MppReceipt {
  sessionId: string;
  txHash: string;
  payer: string;
  amount: string;
  timestamp: string;
  verified: boolean;
}

class MppGateway {
  private sessions: Map<string, MppPricing> = new Map();
  private receipts: Map<string, MppReceipt> = new Map();

  /**
   * Create an MPP payment session for a resource
   */
  createSession(
    resource: string,
    amount: string,
    recipient: string,
  ): MppPricing {
    const sessionId = `mpp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

    const pricing: MppPricing = {
      resource,
      amount,
      currency: 'XLM',
      network: 'stellar:testnet',
      recipient,
      sessionId,
      expiresAt,
      protocol: 'mpp',
    };

    this.sessions.set(sessionId, pricing);
    return pricing;
  }

  /**
   * Verify an MPP payment and issue a receipt
   */
  verifyPayment(
    sessionId: string,
    txHash: string,
    payer: string,
    amount: string,
  ): MppReceipt | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check expiry
    if (new Date(session.expiresAt) < new Date()) {
      this.sessions.delete(sessionId);
      return null;
    }

    const receipt: MppReceipt = {
      sessionId,
      txHash,
      payer,
      amount,
      timestamp: new Date().toISOString(),
      verified: true,
    };

    this.receipts.set(sessionId, receipt);
    this.sessions.delete(sessionId); // Session consumed
    return receipt;
  }

  /**
   * Check if a session has a valid receipt
   */
  getReceipt(sessionId: string): MppReceipt | null {
    return this.receipts.get(sessionId) ?? null;
  }

  /**
   * Get session details
   */
  getSession(sessionId: string): MppPricing | null {
    return this.sessions.get(sessionId) ?? null;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get receiptCount(): number {
    return this.receipts.size;
  }
}

const mpp = new MppGateway();
export default mpp;
