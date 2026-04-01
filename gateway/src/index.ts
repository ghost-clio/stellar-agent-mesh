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
// auth.ts still exists but SEP-0010 endpoints removed — payments ARE the auth
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

// ── Fiat price cache (XLM→USD) ──
let xlmUsdPrice = 0;
let xlmPriceUpdatedAt = 0;

async function getXlmUsd(): Promise<number> {
  // Cache for 5 minutes
  if (xlmUsdPrice > 0 && Date.now() - xlmPriceUpdatedAt < 300000) {
    return xlmUsdPrice;
  }
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd');
    const data = await resp.json() as any;
    xlmUsdPrice = data?.stellar?.usd ?? 0;
    xlmPriceUpdatedAt = Date.now();
  } catch {
    // Keep stale price if fetch fails
  }
  return xlmUsdPrice;
}

function xlmToUsd(xlm: number, rate: number): string {
  return rate > 0 ? `$${(xlm * rate).toFixed(2)}` : 'N/A';
}

// Transaction log for demo/audit
interface TxLogEntry {
  timestamp: string;
  buyer: string;
  buyerFed?: string;
  service: string;
  amount: number;
  txHash: string;
  verified: boolean;
  type: 'payment' | 'path_payment' | 'rejection' | 'mpp';
  protocol?: 'x402' | 'mpp';
  details?: Record<string, unknown>;
}

import fs from "node:fs";

const MAX_TX_LOG = 10000;
const GATEWAY_TX_LOG = process.env.GATEWAY_TX_LOG || "./transactions.jsonl";
const txLog: TxLogEntry[] = [];

// Load existing tx log on startup (survives restarts)
try {
  if (fs.existsSync(GATEWAY_TX_LOG)) {
    const lines = fs.readFileSync(GATEWAY_TX_LOG, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines.slice(-MAX_TX_LOG)) {
      try { txLog.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    console.log(`[${new Date().toISOString()}] Loaded ${txLog.length} transactions from ${GATEWAY_TX_LOG}`);
  }
} catch { /* first run */ }

function pushTxLog(entry: TxLogEntry): void {
  txLog.push(entry);
  if (txLog.length > MAX_TX_LOG) {
    txLog.splice(0, txLog.length - MAX_TX_LOG);
  }
  // Append to persistent JSONL
  try {
    fs.appendFileSync(GATEWAY_TX_LOG, JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* don't crash over logging */ }
}

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

  pushTxLog({
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

  // Generate a one-time capability token
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
  const deliverySecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const hmac = crypto.createHmac('sha256', deliverySecret)
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
  const { id, seller, price, capability, endpoint, name, asset } = req.body;
  if (!id || !seller || price == null || !capability || !endpoint) {
    res.status(400).json({ error: 'missing required fields: id, seller, price, capability, endpoint' });
    return;
  }
  registry.registerService(id, seller, price, capability, endpoint, asset || 'native');
  // Auto-register federation address if name provided
  if (name) {
    federation.register(name, seller);
  }
  const fedAddr = name ? `${name.toLowerCase()}*${FEDERATION_DOMAIN}` : undefined;
  res.status(201).json({ registered: id, federation: fedAddr });
});

// POST /stats/failure — Record a service delivery failure
app.post('/stats/failure', (req: Request, res: Response) => {
  const { agent, reason } = req.body;
  if (!agent) {
    res.status(400).json({ error: 'missing agent address' });
    return;
  }
  registry.updateReputation(agent, false);
  const stats = registry.getReputation(agent);
  const fed = federation.resolveByAddress(agent);
  console.log(`[${new Date().toISOString()}] ⚠️ FAILURE RECORDED | ${fed?.stellar_address ?? agent.slice(0, 12)} | reason: ${reason} | ${stats.successCount}/${stats.txCount}`);
  res.json({ agent, reason, stats, federation: fed?.stellar_address });
});

app.get('/discover', async (req: Request, res: Response) => {
  const capability = String(req.query.capability || '');
  if (!capability) {
    res.status(400).json({ error: 'missing query parameter: capability' });
    return;
  }
  const ids = registry.discover(capability);
  const rate = await getXlmUsd();
  const enriched = ids.map(id => {
    const svc = registry.getService(id);
    const fed = svc ? federation.resolveByAddress(svc.seller) : null;
    const isXlm = !svc?.asset || svc.asset === 'native';
    return {
      id, seller: svc?.seller, fedAddress: fed?.stellar_address,
      capability: svc?.capability, price: svc?.price,
      asset: svc?.asset ?? 'native',
      priceUsd: isXlm && svc?.price ? xlmToUsd(svc.price, rate) : (svc?.asset === 'USDC' ? `$${svc.price}` : 'N/A'),
    };
  });
  res.json({ capability, services: enriched, xlmUsdRate: rate > 0 ? rate : 'unavailable' });
});

app.get('/stats/:address', (req: Request, res: Response) => {
  const address = String(req.params.address);
  const stats = registry.getReputation(address);
  const fed = federation.resolveByAddress(address);
  res.json({ address, fedAddress: fed?.stellar_address, ...stats });
});

// Keep /reputation as alias for backward compat
app.get('/reputation/:address', (req: Request, res: Response) => {
  const address = String(req.params.address);
  const stats = registry.getReputation(address);
  const fed = federation.resolveByAddress(address);
  res.json({ address, fedAddress: fed?.stellar_address, ...stats });
});

// GET /spending — Your own spending history. Address from X-BUYER-ADDRESS header.
// No address param = no way to pull someone else's data.
app.get('/spending', async (req: Request, res: Response) => {
  const rawBuyer = req.headers['x-buyer-address'];
  const address = Array.isArray(rawBuyer) ? rawBuyer[0] : rawBuyer;

  if (!address) {
    res.status(400).json({ error: 'missing X-BUYER-ADDRESS header' });
    return;
  }

  const fed = federation.resolveByAddress(address);

  // Time filtering: ?since=2026-03-01&until=2026-04-01&limit=50
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;

  const summary = registry.getSpendingSummary(address, {
    since: since ? new Date(since).toISOString() : undefined,
    until: until ? new Date(until).toISOString() : undefined,
    limit: Math.min(limit, 100), // cap at 100
  });
  const policy = registry.getSpendingPolicy(address);

  const rate = await getXlmUsd();

  res.json({
    agent: address,
    federation: fed?.stellar_address ?? null,
    ...summary,
    totalSpentUsd: xlmToUsd(summary.totalSpent, rate),
    xlmUsdRate: rate > 0 ? rate : 'unavailable',
    policy: policy ?? 'none',
  });
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

  // Price query mode: GET /service/:id?buyer=<pubkey> returns pricing + reliability info
  const queryBuyer = req.query.buyer as string | undefined;
  if (queryBuyer && !req.headers['x-payment-proof']) {
    const stats = registry.getReputation(queryBuyer);
    const buyerFed = federation.resolveByAddress(queryBuyer);
    res.json({
      service: id,
      price: service.price,
      buyer: queryBuyer,
      buyerFederation: buyerFed?.stellar_address ?? null,
      reliability: stats,
    });
    return;
  }

  const rawProof = req.headers['x-payment-proof'];
  const paymentProof = Array.isArray(rawProof) ? rawProof[0] : rawProof;

  if (!paymentProof) {
    // x402 flow: Return 402 Payment Required
    const rawBuyer = req.headers['x-buyer-address'];
    const buyerAddress: string = (Array.isArray(rawBuyer) ? rawBuyer[0] : rawBuyer) ?? 'unknown';
    const price = registry.getPrice(id);
    const buyerFed = federation.resolveByAddress(buyerAddress);

    const service = registry.getService(id);
    const serviceAsset = service?.asset ?? 'native';
    const requirement: PaymentRequirement = {
      amount: price,
      asset: serviceAsset,
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
    : registry.getPrice(id);

  // Rate limit check → 429
  if (!registry.checkRateLimit(buyerAddress)) {
    res.status(429).json({ error: 'rate_limit_exceeded', message: 'Too many requests per minute' });
    return;
  }
  registry.recordRequest(buyerAddress);

  // Blocklist check → 403
  if (registry.isBlocked(buyerAddress, service.seller)) {
    res.status(403).json({
      error: 'seller_blocked',
      seller: service.seller,
      message: 'This seller is on your blocklist.',
    });
    return;
  }

  // Spending policy check → 403 (falls back to default policy if no custom one)
  if (!registry.checkSpend(buyerAddress, paymentAmount)) {
    pushTxLog({
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

  // Forward to actual service endpoint (native fetch, no axios)
  let responseData: unknown;
  try {
    const query = req.query.q || req.query.query || 'default';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const serviceResponse = await fetch(
      `${service.endpoint}?q=${encodeURIComponent(String(query))}`,
      {
        headers: { 'X-BUYER-ADDRESS': buyerAddress, 'X-PAYMENT-MEMO': paymentProof ?? '' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    responseData = await serviceResponse.json();
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
  registry.confirmSpend(buyerAddress, paymentAmount, id);

  pushTxLog({
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

// Chain payments removed — in practice, agents buy services independently.
// If a marketplace needs multi-hop orchestration, it runs its own gateway.

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

app.get('/txlog', (req: Request, res: Response) => {
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 500) : 100;
  const format = req.query.format as string | undefined;

  let filtered = txLog;
  if (since) filtered = filtered.filter(t => t.timestamp >= new Date(since).toISOString());
  if (until) filtered = filtered.filter(t => t.timestamp <= new Date(until).toISOString());

  const payments = filtered.filter((t) => t.type === 'payment');
  const pathPayments = filtered.filter((t) => t.type === 'path_payment');
  const rejections = filtered.filter((t) => t.type === 'rejection');
  const mppTxs = filtered.filter((t) => t.type === 'mpp');

  // CSV export for SIEM/compliance
  if (format === 'csv') {
    const header = 'timestamp,buyer,service,amount,txHash,verified,type,protocol\n';
    const rows = filtered.slice(-limit).map(t =>
      `${t.timestamp},${t.buyer},${t.service},${t.amount},${t.txHash},${t.verified},${t.type},${t.protocol ?? 'x402'}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=txlog.csv');
    res.send(header + rows);
    return;
  }

  res.json({
    count: filtered.length,
    verified: filtered.filter((t) => t.verified).length,
    breakdown: {
      payments: payments.length,
      pathPayments: pathPayments.length,
      rejections: rejections.length,
      mpp: mppTxs.length,
    },
    protocols: {
      x402: filtered.filter(t => t.protocol === 'x402' || !t.protocol).length,
      mpp: mppTxs.length,
    },
    period: { from: since ?? null, to: until ?? null },
    transactions: filtered.slice(-limit),
  });
});

// ──────────────────────────────────────────
// ADMIN — Fleet management (Dave's dashboard)
// ──────────────────────────────────────────

const ADMIN_KEY = process.env.ADMIN_KEY || '';

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_KEY) {
    res.status(501).json({ error: 'admin_not_configured', message: 'Set ADMIN_KEY env var to enable admin endpoints' });
    return false;
  }
  const provided = req.headers['x-admin-key'] || req.query.key;
  if (provided !== ADMIN_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// GET /admin/spending — All agents' spending, sorted by today's spend
app.get('/admin/spending', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rate = await getXlmUsd();
  const fleet = registry.getAllAgentSpending().map(a => ({
    ...a,
    federation: federation.resolveByAddress(a.agent)?.stellar_address ?? null,
    todaySpentUsd: xlmToUsd(a.todaySpent, rate),
  }));

  const totalToday = fleet.reduce((sum, a) => sum + a.todaySpent, 0);

  res.json({
    agentCount: fleet.length,
    totalTodaySpent: parseFloat(totalToday.toFixed(7)),
    totalTodaySpentUsd: xlmToUsd(totalToday, rate),
    defaultPolicy: registry.getDefaultPolicy() ?? 'none',
    agents: fleet,
  });
});

// POST /admin/default-policy — Set fleet-wide default spending policy
app.post('/admin/default-policy', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const { perTxLimit, dailyLimit } = req.body;
  if (perTxLimit == null || dailyLimit == null) {
    res.status(400).json({ error: 'missing perTxLimit or dailyLimit' });
    return;
  }
  registry.setDefaultPolicy(perTxLimit, dailyLimit);
  res.json({ defaultPolicy: { perTxLimit, dailyLimit }, message: 'Applies to all agents without a custom policy' });
});

// POST /admin/rate-limit — Set per-agent rate limit (max transactions per minute)
app.post('/admin/rate-limit', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const { agent, maxPerMinute } = req.body;
  if (!agent || !maxPerMinute) {
    res.status(400).json({ error: 'missing agent or maxPerMinute' });
    return;
  }
  registry.setRateLimit(agent, maxPerMinute);
  res.json({ agent, maxPerMinute });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    services: registry.serviceCount,
    transactions: txLog.length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    network: 'stellar:testnet',
    federation: { domain: FEDERATION_DOMAIN, entries: federation.count },
    auth: 'payment-based (no separate auth layer — signed Stellar txs ARE proof of identity)',
    protocols: ['x402', 'mpp'],
    features: [
      'payment', 'path_payment', 'spending_policy', 'spending_dashboard', 'reliability_tracking',
      'time_bounds', 'federation', 'mpp', 'blocklist', 'spend_alerts', 'fiat_display',
      'contacts', 'rate_limiting', 'admin_fleet_view', 'default_policies', 'csv_export',
    ],
  });
});

// ──────────────────────────────────────────
// SEP-24 — Fiat on-ramp ("add money with your credit card")
// ──────────────────────────────────────────

import {
  KNOWN_ANCHORS, fetchAnchorInfo, getAnchorAssets,
  initiateDeposit, checkTransaction,
} from './sep24.js';

// GET /fund/anchors — List known fiat on-ramp providers
app.get('/fund/anchors', (_req: Request, res: Response) => {
  res.json({
    anchors: Object.entries(KNOWN_ANCHORS).map(([name, domain]) => ({ name, domain })),
    message: 'Use POST /fund/deposit to start a deposit with any anchor',
  });
});

// GET /fund/info?anchor=mykobo — Get anchor's supported assets and methods
app.get('/fund/info', async (req: Request, res: Response) => {
  try {
    const anchorName = String(req.query.anchor || '');
    const domain = KNOWN_ANCHORS[anchorName] || anchorName;
    if (!domain) {
      res.status(400).json({ error: 'missing anchor param', knownAnchors: Object.keys(KNOWN_ANCHORS) });
      return;
    }
    const info = await fetchAnchorInfo(domain);
    const assets = await getAnchorAssets(info.transferServer);
    res.json({ anchor: info, assets });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// POST /fund/deposit — Start an interactive deposit (returns URL for human)
app.post('/fund/deposit', async (req: Request, res: Response) => {
  try {
    const { anchor, asset, account, amount } = req.body;
    if (!anchor || !account) {
      res.status(400).json({ error: 'missing anchor or account', example: { anchor: 'mykobo', asset: 'USDC', account: 'GABCDEF...', amount: '20' } });
      return;
    }
    const domain = KNOWN_ANCHORS[anchor] || anchor;
    const info = await fetchAnchorInfo(domain);
    const depositAsset = asset || 'native';
    const result = await initiateDeposit(info.transferServer, depositAsset, account, amount);
    res.json({
      ...result,
      asset: depositAsset,
      instructions: 'Send this URL to your human. They pay with credit card or bank transfer. XLM arrives in the agent wallet — covers both services and gas fees.',
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// GET /fund/status?anchor=mykobo&id=txn123 — Check deposit status
app.get('/fund/status', async (req: Request, res: Response) => {
  try {
    const anchorName = String(req.query.anchor || '');
    const txId = String(req.query.id || '');
    if (!anchorName || !txId) {
      res.status(400).json({ error: 'missing anchor or id' });
      return;
    }
    const domain = KNOWN_ANCHORS[anchorName] || anchorName;
    const info = await fetchAnchorInfo(domain);
    const status = await checkTransaction(info.transferServer, txId);
    res.json(status);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Error handling
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Stellar Agent Mesh Gateway running on port ${PORT}`);
  console.log(`Network: stellar:testnet | Recipient: ${RECIPIENT_ADDRESS}`);
  console.log(`Federation: ${FEDERATION_DOMAIN}`);
  console.log(`Protocols: x402 + MPP | Features: 16 | Admin: ${ADMIN_KEY ? 'enabled' : 'disabled'}`);
});

export default app;
