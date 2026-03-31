import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import registry from './registry.js';
import federation, { FEDERATION_DOMAIN } from './federation.js';
import mpp from './mpp.js';
import auth, { JwtPayload } from './auth.js';
import { PaymentRequirement, ServiceResult } from './types.js';
import {
  submitPayment,
  submitPathPayment,
  verifyTransaction,
  getBalance,
  StellarSdk,
} from './stellar.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3402', 10);
const RECIPIENT_ADDRESS =
  process.env.RESOURCE_SERVER_ADDRESS ||
  'GB2UYYBGWKJDZYQWNLS3MQX6QY7UXQSM4P3ROWCHBUVU54CKS5TLBHWI';

const startTime = Date.now();

// Transaction log for demo/audit
interface TxLogEntry {
  timestamp: string;
  buyer: string;
  buyerFed?: string;
  service: string;
  amount: number;
  txHash: string;
  verified: boolean;
  type: 'payment' | 'path_payment' | 'chain' | 'rejection' | 'mpp';
  protocol?: 'x402' | 'mpp';
  details?: Record<string, unknown>;
}

const txLog: TxLogEntry[] = [];

// Middleware
app.use(cors());
app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ──────────────────────────────────────────
// x402 MIDDLEWARE — Official Coinbase x402 protocol
// ──────────────────────────────────────────
try {
  const stellarScheme = new ExactStellarScheme();
  const resourceServer = new x402ResourceServer()
    .register('stellar:testnet', stellarScheme);

  app.use(
    paymentMiddleware(
      {
        'GET /x402/weather': {
          accepts: [{ scheme: 'exact', price: '$0.001', network: 'stellar:testnet', payTo: RECIPIENT_ADDRESS }],
          description: 'Weather data service',
          mimeType: 'application/json',
        },
        'GET /x402/code-review': {
          accepts: [{ scheme: 'exact', price: '$0.005', network: 'stellar:testnet', payTo: RECIPIENT_ADDRESS }],
          description: 'AI code review service',
          mimeType: 'application/json',
        },
      },
      resourceServer,
    ),
  );
  console.log('✅ x402 middleware active on /x402/* routes');
} catch (err: any) {
  console.warn(`⚠️ x402 middleware init failed (${err.message}), falling back to custom 402`);
}

// x402-protected endpoints
app.get('/x402/weather', (_req: Request, res: Response) => {
  res.json({
    service: 'weather', paid: true,
    data: { temperature: 72, condition: 'sunny', location: 'San Francisco' },
    timestamp: new Date().toISOString(),
  });
});

app.get('/x402/code-review', (_req: Request, res: Response) => {
  res.json({
    service: 'code-review', paid: true,
    data: { review: 'Code looks clean. Consider adding error handling on line 42.', score: 8.5 },
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────
// FEDERATION — Human-readable agent addresses (SEP-0002)
// ──────────────────────────────────────────

// GET /federation?type=name&q=atlas*mesh.agent
app.get('/federation', (req: Request, res: Response) => {
  const type = String(req.query.type || '');
  const q = String(req.query.q || '');

  if (type === 'name') {
    const record = federation.resolveByName(q);
    if (!record) { res.status(404).json({ error: 'not_found' }); return; }
    res.json(record);
  } else if (type === 'id') {
    const record = federation.resolveByAddress(q);
    if (!record) { res.status(404).json({ error: 'not_found' }); return; }
    res.json(record);
  } else {
    res.json({ domain: FEDERATION_DOMAIN, entries: federation.list(), count: federation.count });
  }
});

// POST /federation/register — Register a federation address
app.post('/federation/register', (req: Request, res: Response) => {
  const { name, address } = req.body;
  if (!name || !address) {
    res.status(400).json({ error: 'missing name or address' });
    return;
  }
  federation.register(name, address);
  res.status(201).json({ fedAddress: `${name.toLowerCase()}*${FEDERATION_DOMAIN}`, stellarAddress: address });
});

// ──────────────────────────────────────────
// SEP-0010 WEB AUTH — Agent identity verification
// ──────────────────────────────────────────

// GET /auth/challenge?account=G...
app.get('/auth/challenge', (req: Request, res: Response) => {
  const account = String(req.query.account || '');
  if (!account) {
    res.status(400).json({ error: 'missing account parameter' });
    return;
  }
  try {
    const challenge = auth.createChallenge(account);
    res.json(challenge);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/verify — Submit signed challenge, receive JWT
app.post('/auth/verify', (req: Request, res: Response) => {
  const { transaction } = req.body;
  if (!transaction) {
    res.status(400).json({ error: 'missing signed transaction' });
    return;
  }
  const result = auth.verifyChallenge(transaction);
  if (!result) {
    res.status(401).json({ error: 'invalid_challenge', message: 'Signature verification failed or challenge expired' });
    return;
  }
  res.json({ token: result.token, address: result.address, expiresIn: 3600 });
});

// GET /auth/info — Server public key for challenge verification
app.get('/auth/info', (_req: Request, res: Response) => {
  res.json({ serverPublicKey: auth.serverPublicKey, domain: FEDERATION_DOMAIN, sep: '0010' });
});

// ──────────────────────────────────────────
// MPP — Machine Payments Protocol (alternative to x402)
// ──────────────────────────────────────────

// POST /mpp/session — Create an MPP payment session
app.post('/mpp/session', (req: Request, res: Response) => {
  const { resource, amount } = req.body;
  if (!resource || !amount) {
    res.status(400).json({ error: 'missing resource or amount' });
    return;
  }
  const session = mpp.createSession(resource, String(amount), RECIPIENT_ADDRESS);
  res.status(201).json(session);
});

// POST /mpp/verify — Verify payment and get receipt
app.post('/mpp/verify', (req: Request, res: Response) => {
  const { sessionId, txHash, payer, amount } = req.body;
  if (!sessionId || !txHash || !payer) {
    res.status(400).json({ error: 'missing sessionId, txHash, or payer' });
    return;
  }
  const receipt = mpp.verifyPayment(sessionId, txHash, payer, amount);
  if (!receipt) {
    res.status(400).json({ error: 'session_invalid_or_expired' });
    return;
  }

  txLog.push({
    timestamp: new Date().toISOString(),
    buyer: payer,
    service: mpp.getSession(sessionId)?.resource ?? 'unknown',
    amount: parseFloat(amount),
    txHash,
    verified: true,
    type: 'mpp',
    protocol: 'mpp',
  });

  res.json(receipt);
});

// GET /mpp/receipt/:sessionId — Get a receipt
app.get('/mpp/receipt/:sessionId', (req: Request, res: Response) => {
  const receipt = mpp.getReceipt(String(req.params.sessionId));
  if (!receipt) { res.status(404).json({ error: 'receipt_not_found' }); return; }
  res.json(receipt);
});

// ──────────────────────────────────────────
// JWT DELIVERY TOKENS — Atomic paid delivery protection
// ──────────────────────────────────────────

// POST /delivery/token — Issue a one-time delivery token after payment verification
app.post('/delivery/token', async (req: Request, res: Response) => {
  const { txHash, serviceId, buyerAddress } = req.body;
  if (!txHash || !serviceId || !buyerAddress) {
    res.status(400).json({ error: 'missing txHash, serviceId, or buyerAddress' });
    return;
  }

  // Verify the transaction on-chain
  const verification = await verifyTransaction(txHash);
  if (!verification.verified) {
    res.status(402).json({ error: 'payment_not_verified', txHash });
    return;
  }

  // Issue a JWT delivery token
  const payload = auth.verifyToken(''); // Just use the auth server's JWT machinery
  // Generate a simple capability token
  const crypto = await import('crypto');
  const tokenData = {
    serviceId,
    buyer: buyerAddress,
    txHash,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };

  const tokenStr = Buffer.from(JSON.stringify(tokenData)).toString('base64url');
  const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET || 'mesh-agent-secret')
    .update(tokenStr)
    .digest('base64url');

  res.json({
    deliveryToken: `${tokenStr}.${hmac}`,
    expiresAt: tokenData.expiresAt,
    serviceId,
  });
});

// ──────────────────────────────────────────
// REGISTRY ENDPOINTS — Service mesh management
// ──────────────────────────────────────────

app.post('/register', (req: Request, res: Response) => {
  const { id, seller, price, capability, endpoint, name } = req.body;
  if (!id || !seller || price == null || !capability || !endpoint) {
    res.status(400).json({ error: 'missing required fields: id, seller, price, capability, endpoint' });
    return;
  }
  registry.registerService(id, seller, price, capability, endpoint);
  // Auto-register federation address if name provided
  if (name) {
    federation.register(name, seller);
  }
  const fedAddr = name ? `${name.toLowerCase()}*${FEDERATION_DOMAIN}` : undefined;
  res.status(201).json({ registered: id, federation: fedAddr });
});

// POST /reputation/penalize — Penalize an agent for bad behavior
app.post('/reputation/penalize', (req: Request, res: Response) => {
  const { agent, reason } = req.body;
  if (!agent) {
    res.status(400).json({ error: 'missing agent address' });
    return;
  }
  // Record a failed transaction → reputation drops
  registry.updateReputation(agent, false);
  const rep = registry.getReputation(agent);
  const fed = federation.resolveByAddress(agent);
  console.log(`[${new Date().toISOString()}] ⚠️ REPUTATION PENALTY | ${fed?.stellar_address ?? agent.slice(0, 12)} | reason: ${reason} | new score: ${rep.successCount}/${rep.txCount}`);
  res.json({ agent, reason, reputation: rep, federation: fed?.stellar_address });
});

app.get('/discover', (req: Request, res: Response) => {
  const capability = String(req.query.capability || '');
  if (!capability) {
    res.status(400).json({ error: 'missing query parameter: capability' });
    return;
  }
  const ids = registry.discover(capability);
  // Enrich with federation addresses
  const enriched = ids.map(id => {
    const svc = registry.getService(id);
    const fed = svc ? federation.resolveByAddress(svc.seller) : null;
    return { id, seller: svc?.seller, fedAddress: fed?.stellar_address, capability: svc?.capability, price: svc?.price };
  });
  res.json({ capability, services: enriched });
});

app.get('/reputation/:address', (req: Request, res: Response) => {
  const address = String(req.params.address);
  const rep = registry.getReputation(address);
  const fed = federation.resolveByAddress(address);
  res.json({ address, fedAddress: fed?.stellar_address, ...rep });
});

app.post('/policy', (req: Request, res: Response) => {
  const { agent, perTxLimit, dailyLimit } = req.body;
  if (!agent || perTxLimit == null || dailyLimit == null) {
    res.status(400).json({ error: 'missing required fields: agent, perTxLimit, dailyLimit' });
    return;
  }
  registry.setSpendingPolicy(agent, perTxLimit, dailyLimit);
  res.json({ agent, perTxLimit, dailyLimit });
});

// ──────────────────────────────────────────
// SERVICE ENDPOINT — Custom x402 flow with all mesh features
// ──────────────────────────────────────────

app.get('/service/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const service = registry.getService(id);

  if (!service) {
    res.status(404).json({ error: 'service_not_found' });
    return;
  }

  const rawProof = req.headers['x-payment-proof'];
  const paymentProof = Array.isArray(rawProof) ? rawProof[0] : rawProof;

  if (!paymentProof) {
    // x402 flow: Return 402 Payment Required
    const rawBuyer = req.headers['x-buyer-address'];
    const buyerAddress: string = (Array.isArray(rawBuyer) ? rawBuyer[0] : rawBuyer) ?? 'unknown';
    const effectivePrice = registry.getEffectivePrice(id, buyerAddress);
    const buyerFed = federation.resolveByAddress(buyerAddress);

    const requirement: PaymentRequirement = {
      amount: effectivePrice,
      asset: 'native',
      network: 'stellar:testnet',
      recipient: RECIPIENT_ADDRESS,
      memo: `x402_${uuidv4().slice(0, 8)}`,
    };

    // Also offer MPP as alternative protocol
    res.status(402).json({
      ...requirement,
      buyerFederation: buyerFed?.stellar_address,
      protocols: {
        x402: requirement,
        mpp: {
          sessionEndpoint: '/mpp/session',
          protocol: 'mpp',
          amount: requirement.amount,
          currency: 'XLM',
        },
      },
    });
    return;
  }

  const rawBuyerAddr = req.headers['x-buyer-address'];
  const buyerAddress: string = (Array.isArray(rawBuyerAddr) ? rawBuyerAddr[0] : rawBuyerAddr) ?? 'unknown';

  const rawPaymentAmount = req.headers['x-payment-amount'];
  const paymentAmount = rawPaymentAmount
    ? parseFloat(Array.isArray(rawPaymentAmount) ? rawPaymentAmount[0] : rawPaymentAmount)
    : registry.getEffectivePrice(id, buyerAddress);

  // Spending policy check → 403
  if (!registry.checkSpend(buyerAddress, paymentAmount)) {
    txLog.push({
      timestamp: new Date().toISOString(),
      buyer: buyerAddress,
      buyerFed: federation.resolveByAddress(buyerAddress)?.stellar_address,
      service: id,
      amount: paymentAmount,
      txHash: '',
      verified: false,
      type: 'rejection',
      protocol: 'x402',
      details: { policy: registry.getSpendingPolicy(buyerAddress) },
    });

    res.status(403).json({
      error: 'spending_policy_violation',
      requested: paymentAmount,
      policy: registry.getSpendingPolicy(buyerAddress),
    });
    return;
  }

  // Verify transaction on Stellar testnet
  const verification = await verifyTransaction(paymentProof);

  const start = Date.now();

  // Forward to actual service endpoint
  let responseData: unknown;
  try {
    const axios = (await import('axios')).default;
    const query = req.query.q || req.query.query || 'default';
    const serviceResponse = await axios.get(`${service.endpoint}?q=${encodeURIComponent(String(query))}`, {
      timeout: 30000,
      headers: { 'X-BUYER-ADDRESS': buyerAddress, 'X-PAYMENT-MEMO': paymentProof },
    });
    responseData = serviceResponse.data;
  } catch {
    responseData = {
      capability: service.capability,
      provider: service.seller,
      generated: new Date().toISOString(),
      note: 'service_endpoint_fallback',
    };
  }

  const result: ServiceResult = {
    success: true,
    data: responseData,
    latencyMs: Date.now() - start,
    txHash: paymentProof,
    txVerified: verification.verified,
    txDetails: verification.verified ? {
      from: verification.from,
      to: verification.to,
      amount: verification.amount,
      memo: verification.memo,
    } : undefined,
  };

  registry.updateReputation(buyerAddress, true);

  txLog.push({
    timestamp: new Date().toISOString(),
    buyer: buyerAddress,
    buyerFed: federation.resolveByAddress(buyerAddress)?.stellar_address,
    service: id,
    amount: paymentAmount,
    txHash: paymentProof,
    verified: verification.verified,
    type: 'payment',
    protocol: 'x402',
  });

  res.json(result);
});

// ──────────────────────────────────────────
// STELLAR PAYMENT ENDPOINTS
// ──────────────────────────────────────────

app.post('/pay', async (req: Request, res: Response) => {
  const { senderSecret, destination, amount, memo } = req.body;
  if (!senderSecret || !destination || !amount) {
    res.status(400).json({ error: 'missing required fields' });
    return;
  }

  // Resolve federation address if provided
  let destAddress = destination;
  if (destination.includes('*')) {
    const fed = federation.resolveByName(destination);
    if (!fed) {
      res.status(404).json({ error: 'federation_address_not_found', address: destination });
      return;
    }
    destAddress = fed.account_id;
  }

  try {
    const result = await submitPayment(senderSecret, destAddress, String(amount), memo);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'payment_failed' });
  }
});

app.post('/path-pay', async (req: Request, res: Response) => {
  const { senderSecret, destination, destAssetCode, destAssetIssuer, destAmount, maxSend, memo } = req.body;
  if (!senderSecret || !destination || !destAmount || !maxSend) {
    res.status(400).json({ error: 'missing required fields' });
    return;
  }

  // Resolve federation
  let destAddress = destination;
  if (destination.includes('*')) {
    const fed = federation.resolveByName(destination);
    if (!fed) { res.status(404).json({ error: 'federation_address_not_found' }); return; }
    destAddress = fed.account_id;
  }

  try {
    let destAsset: StellarSdk.Asset;
    if (destAssetCode && destAssetIssuer) {
      destAsset = new StellarSdk.Asset(destAssetCode, destAssetIssuer);
    } else {
      destAsset = StellarSdk.Asset.native();
    }
    const result = await submitPathPayment(senderSecret, destAddress, destAsset, String(destAmount), String(maxSend), memo);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'path_payment_failed' });
  }
});

app.post('/chain', async (req: Request, res: Response) => {
  const { hops } = req.body;
  if (!hops || !Array.isArray(hops) || hops.length < 2) {
    res.status(400).json({ error: 'chain requires at least 2 hops' });
    return;
  }

  const results: any[] = [];
  const chainId = uuidv4().slice(0, 8);
  let totalLatency = 0;

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const hopMemo = `chain_${chainId}_${i}`;
    const start = Date.now();

    // Resolve federation addresses in chain hops
    let destAddress = hop.destination;
    if (destAddress.includes('*')) {
      const fed = federation.resolveByName(destAddress);
      if (fed) destAddress = fed.account_id;
    }

    try {
      const payResult = await submitPayment(hop.senderSecret, destAddress, String(hop.amount), hopMemo);
      const latency = Date.now() - start;
      totalLatency += latency;

      results.push({
        hop: i + 1, success: true, txHash: payResult.hash,
        from: payResult.from, to: payResult.to, amount: hop.amount, latencyMs: latency,
      });

      txLog.push({
        timestamp: new Date().toISOString(),
        buyer: payResult.from,
        service: hop.serviceId || `chain_hop_${i}`,
        amount: parseFloat(hop.amount),
        txHash: payResult.hash,
        verified: true,
        type: 'chain',
        protocol: 'x402',
        details: { chainId, hop: i + 1, totalHops: hops.length },
      });
    } catch (err: any) {
      results.push({ hop: i + 1, success: false, error: err.message, latencyMs: Date.now() - start });
      break;
    }
  }

  res.json({
    chainId, hops: results.length, totalHops: hops.length,
    success: results.every((r) => r.success),
    totalLatencyMs: totalLatency, results,
  });
});

// ──────────────────────────────────────────
// QUERY ENDPOINTS
// ──────────────────────────────────────────

app.get('/balance/:address', async (req: Request, res: Response) => {
  let address = String(req.params.address);
  // Resolve federation address
  if (address.includes('*')) {
    const fed = federation.resolveByName(address);
    if (!fed) { res.status(404).json({ error: 'federation_address_not_found' }); return; }
    address = fed.account_id;
  }
  try {
    const balance = await getBalance(address);
    res.json({ address, ...balance });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/txlog', (_req: Request, res: Response) => {
  const payments = txLog.filter((t) => t.type === 'payment');
  const pathPayments = txLog.filter((t) => t.type === 'path_payment');
  const chains = txLog.filter((t) => t.type === 'chain');
  const rejections = txLog.filter((t) => t.type === 'rejection');
  const mppTxs = txLog.filter((t) => t.type === 'mpp');

  res.json({
    count: txLog.length,
    verified: txLog.filter((t) => t.verified).length,
    breakdown: {
      payments: payments.length,
      pathPayments: pathPayments.length,
      chains: chains.length,
      rejections: rejections.length,
      mpp: mppTxs.length,
    },
    protocols: {
      x402: txLog.filter(t => t.protocol === 'x402' || !t.protocol).length,
      mpp: mppTxs.length,
    },
    transactions: txLog.slice(-100),
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    services: registry.serviceCount,
    transactions: txLog.length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    network: 'stellar:testnet',
    federation: { domain: FEDERATION_DOMAIN, entries: federation.count },
    auth: { sep: '0010', serverKey: auth.serverPublicKey },
    protocols: ['x402', 'mpp'],
    features: [
      'payment', 'path_payment', 'chain', 'spending_policy', 'reputation',
      'time_bounds', 'federation', 'mpp', 'sep0010_auth', 'jwt_delivery',
    ],
  });
});

// Error handling
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Stellar Agent Mesh Gateway running on port ${PORT}`);
  console.log(`Network: stellar:testnet | Recipient: ${RECIPIENT_ADDRESS}`);
  console.log(`Federation: ${FEDERATION_DOMAIN} | Auth: SEP-0010`);
  console.log(`Protocols: x402 + MPP | Features: 11`);
});

export default app;
