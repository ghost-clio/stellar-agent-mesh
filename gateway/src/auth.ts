/**
 * SEP-0010 Web Authentication — Agent identity verification
 *
 * Implements Stellar's SEP-0010 challenge-response auth:
 *   1. Agent requests challenge from gateway
 *   2. Gateway returns a Stellar transaction to sign (manage_data op)
 *   3. Agent signs with their secret key and returns
 *   4. Gateway verifies signature → issues JWT
 *
 * This proves an agent controls a Stellar account without revealing secrets.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import * as crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const CHALLENGE_EXPIRY_SECONDS = 300; // 5 minutes
const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

interface Challenge {
  transaction: string; // base64 XDR
  clientAccount: string;
  createdAt: number;
}

interface JwtPayload {
  sub: string; // Stellar address
  iat: number;
  exp: number;
  iss: string;
}

class AuthServer {
  private serverKeypair: StellarSdk.Keypair;
  private challenges: Map<string, Challenge> = new Map();

  constructor() {
    // Generate a server keypair for signing challenges
    this.serverKeypair = StellarSdk.Keypair.random();
  }

  /**
   * Create a SEP-0010 challenge transaction for an agent to sign
   */
  createChallenge(clientAccount: string): { transaction: string; networkPassphrase: string } {
    const nonce = crypto.randomBytes(48).toString('base64');

    // Build a challenge transaction with manage_data op
    const account = new StellarSdk.Account(this.serverKeypair.publicKey(), '-1');
    const now = Math.floor(Date.now() / 1000);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: {
        minTime: now,
        maxTime: now + CHALLENGE_EXPIRY_SECONDS,
      },
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: 'mesh.agent auth',
          value: Buffer.from(nonce),
          source: clientAccount,
        })
      )
      .build();

    tx.sign(this.serverKeypair);

    const xdr = tx.toXDR();
    const challengeId = crypto.createHash('sha256').update(xdr).digest('hex').slice(0, 16);

    this.challenges.set(challengeId, {
      transaction: xdr,
      clientAccount,
      createdAt: now,
    });

    return {
      transaction: xdr,
      networkPassphrase: NETWORK_PASSPHRASE,
    };
  }

  /**
   * Verify a signed challenge and issue a JWT
   */
  verifyChallenge(signedXdr: string): { token: string; address: string } | null {
    try {
      const tx = new StellarSdk.Transaction(signedXdr, NETWORK_PASSPHRASE);

      // Verify time bounds
      const now = Math.floor(Date.now() / 1000);
      const timeBounds = tx.timeBounds;
      if (!timeBounds || now < parseInt(timeBounds.minTime) || now > parseInt(timeBounds.maxTime)) {
        return null; // Challenge expired
      }

      // Find the manage_data op to get the client account
      const ops = tx.operations;
      const authOp = ops.find(
        (op) => op.type === 'manageData' && (op as any).name === 'mesh.agent auth'
      );
      if (!authOp || !authOp.source) return null;

      const clientAccount = authOp.source;

      // Verify server signature
      const serverSigned = this.verifySignature(tx, this.serverKeypair.publicKey());
      if (!serverSigned) return null;

      // Verify client signature
      const clientSigned = this.verifySignature(tx, clientAccount);
      if (!clientSigned) return null;

      // Issue JWT
      const payload: JwtPayload = {
        sub: clientAccount,
        iat: now,
        exp: now + TOKEN_EXPIRY_SECONDS,
        iss: 'mesh.agent',
      };

      // Simple JWT (base64 header.payload.signature)
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');

      return {
        token: `${header}.${body}.${sig}`,
        address: clientAccount,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify a JWT token
   */
  verifyToken(token: string): JwtPayload | null {
    try {
      const [header, body, sig] = token.split('.');
      const expectedSig = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${body}`)
        .digest('base64url');

      if (sig !== expectedSig) return null;

      const payload: JwtPayload = JSON.parse(Buffer.from(body, 'base64url').toString());
      const now = Math.floor(Date.now() / 1000);

      if (payload.exp < now) return null;

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Check if a transaction has a valid signature from a given account
   */
  private verifySignature(tx: StellarSdk.Transaction, publicKey: string): boolean {
    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    const txHash = tx.hash();

    for (const sig of tx.signatures) {
      try {
        if (keypair.verify(txHash, sig.signature())) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  get serverPublicKey(): string {
    return this.serverKeypair.publicKey();
  }
}

const auth = new AuthServer();
export default auth;
export { JwtPayload };
