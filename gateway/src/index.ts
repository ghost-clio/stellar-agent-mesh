import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import registry from './registry.js';
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
  service: string;
  amount: number;
  txHash: string;
  verified: boolean;
  type: 'payment' | 'path_payment' | 'chain' | 'rejection';
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
// Protects /x402/* routes with real payment requirements
// ──────────────────────────────────────────
try {
  const stellarScheme = new ExactStellarScheme();
  const resourceServer = new x402ResourceServer()
    .register('stellar:testnet', stellarScheme);

  app.use(
    paymentMiddleware(
      {
        'GET /x402/weather': {
          accepts: [
            {
              scheme: 'exact',
              price: '$0.001',
              network: 'stellar:testnet',
              payTo: RECIPIENT_ADDRESS,
            },
          ],
          description: 'Weather data service',
          mimeType: 'application/json',
        },
        'GET /x402/code-review': {
          accepts: [
            {
              scheme: 'exact',
              price: '$0.005',
              network: 'stellar:testnet',
              payTo: RECIPIENT_ADDRESS,
            },
          ],
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

// x402-protected endpoints (behind paymentMiddleware)
app.get('/x402/weather', (_req: Request, res: Response) => {
  res.json({
    service: 'weather',
    data: { temperature: 72, condition: 'sunny', location: 'San Francisco' },
    timestamp: new Date().toISOString(),
    paid: true,
  });
});

app.get('/x402/code-review', (_req: Request, res: Response) => {
  res.json({
    service: 'code-review',
    data: { review: 'Code looks clean. Consider adding error handling on line 42.', score: 8.5 },
    timestamp: new Date().toISOString(),
    paid: true,
  });
});

// ──────────────────────────────────────────
// REGISTRY ENDPOINTS — Service mesh management
// ──────────────────────────────────────────

// POST /register
app.post('/register', (req: Request, res: Response) => {
  const { id, seller, price, capability, endpoint } = req.body;
  if (!id || !seller || price == null || !capability || !endpoint) {
    res.status(400).json({ error: 'missing required fields: id, seller, price, capability, endpoint' });
    return;
  }
  registry.registerService(id, seller, price, capability, endpoint);
  res.status(201).json({ registered: id });
});

// GET /discover?capability=X
app.get('/discover', (req: Request, res: Response) => {
  const capability = String(req.query.capability || '');
  if (!capability) {
    res.status(400).json({ error: 'missing query parameter: capability' });
    return;
  }
  const ids = registry.discover(capability);
  res.json({ capability, services: ids });
});

// GET /reputation/:address
app.get('/reputation/:address', (req: Request, res: Response) => {
  const address = String(req.params.address);
  const rep = registry.getReputation(address);
  res.json({ address, ...rep });
});

// POST /policy
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
// SERVICE ENDPOINT — Custom x402 flow with mesh features
// Supports: reputation discounts, spending policies, tx verification
// ──────────────────────────────────────────

// GET /service/:id — x402-protected with mesh features
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

    const requirement: PaymentRequirement = {
      amount: effectivePrice,
      asset: 'native',
      network: 'stellar:testnet',
      recipient: RECIPIENT_ADDRESS,
      memo: `x402_${uuidv4().slice(0, 8)}`,
    };

    res.status(402).json(requirement);
    return;
  }

  const rawBuyerAddr = req.headers['x-buyer-address'];
  const buyerAddress: string = (Array.isArray(rawBuyerAddr) ? rawBuyerAddr[0] : rawBuyerAddr) ?? 'unknown';

  const rawPaymentAmount = req.headers['x-payment-amount'];
  const paymentAmount = rawPaymentAmount
    ? parseFloat(Array.isArray(rawPaymentAmount) ? rawPaymentAmount[0] : rawPaymentAmount)
    : registry.getEffectivePrice(id, buyerAddress);

  // Spending policy check → 403 if violated
  if (!registry.checkSpend(buyerAddress, paymentAmount)) {
    txLog.push({
      timestamp: new Date().toISOString(),
      buyer: buyerAddress,
      service: id,
      amount: paymentAmount,
      txHash: '',
      verified: false,
      type: 'rejection',
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
    service: id,
    amount: paymentAmount,
    txHash: paymentProof,
    verified: verification.verified,
    type: 'payment',
  });

  res.json(result);
});

// ──────────────────────────────────────────
// STELLAR PAYMENT ENDPOINTS
// ──────────────────────────────────────────

// POST /pay — Direct Stellar payment
app.post('/pay', async (req: Request, res: Response) => {
  const { senderSecret, destination, amount, memo } = req.body;
  if (!senderSecret || !destination || !amount) {
    res.status(400).json({ error: 'missing required fields: senderSecret, destination, amount' });
    return;
  }
  try {
    const result = await submitPayment(senderSecret, destination, String(amount), memo);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'payment_failed' });
  }
});

// POST /path-pay — Path payment via Stellar DEX
app.post('/path-pay', async (req: Request, res: Response) => {
  const { senderSecret, destination, destAssetCode, destAssetIssuer, destAmount, maxSend, memo } = req.body;
  if (!senderSecret || !destination || !destAmount || !maxSend) {
    res.status(400).json({ error: 'missing required fields: senderSecret, destination, destAmount, maxSend' });
    return;
  }

  try {
    let destAsset: StellarSdk.Asset;
    if (destAssetCode && destAssetIssuer) {
      destAsset = new StellarSdk.Asset(destAssetCode, destAssetIssuer);
    } else {
      destAsset = StellarSdk.Asset.native();
    }

    const result = await submitPathPayment(
      senderSecret, destination, destAsset, String(destAmount), String(maxSend), memo
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'path_payment_failed' });
  }
});

// POST /chain — Three-agent chain: A→B→C with sequential x402 payments
app.post('/chain', async (req: Request, res: Response) => {
  const { hops } = req.body;
  // hops: [{ senderSecret, destination, amount, serviceId, memo }]
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

    try {
      const payResult = await submitPayment(
        hop.senderSecret, hop.destination, String(hop.amount), hopMemo
      );
      const latency = Date.now() - start;
      totalLatency += latency;

      results.push({
        hop: i + 1,
        success: true,
        txHash: payResult.hash,
        from: payResult.from,
        to: payResult.to,
        amount: hop.amount,
        latencyMs: latency,
      });

      txLog.push({
        timestamp: new Date().toISOString(),
        buyer: payResult.from,
        service: hop.serviceId || `chain_hop_${i}`,
        amount: parseFloat(hop.amount),
        txHash: payResult.hash,
        verified: true,
        type: 'chain',
        details: { chainId, hop: i + 1, totalHops: hops.length },
      });
    } catch (err: any) {
      results.push({
        hop: i + 1,
        success: false,
        error: err.message,
        latencyMs: Date.now() - start,
      });
      break; // Chain breaks on failure
    }
  }

  res.json({
    chainId,
    hops: results.length,
    totalHops: hops.length,
    success: results.every((r) => r.success),
    totalLatencyMs: totalLatency,
    results,
  });
});

// ──────────────────────────────────────────
// QUERY ENDPOINTS
// ──────────────────────────────────────────

// GET /balance/:address
app.get('/balance/:address', async (req: Request, res: Response) => {
  const address = String(req.params.address);
  try {
    const balance = await getBalance(address);
    res.json({ address, ...balance });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /txlog — Transaction audit log
app.get('/txlog', (_req: Request, res: Response) => {
  const payments = txLog.filter((t) => t.type === 'payment');
  const pathPayments = txLog.filter((t) => t.type === 'path_payment');
  const chains = txLog.filter((t) => t.type === 'chain');
  const rejections = txLog.filter((t) => t.type === 'rejection');

  res.json({
    count: txLog.length,
    verified: txLog.filter((t) => t.verified).length,
    breakdown: {
      payments: payments.length,
      pathPayments: pathPayments.length,
      chains: chains.length,
      rejections: rejections.length,
    },
    transactions: txLog.slice(-100),
  });
});

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    services: registry.serviceCount,
    transactions: txLog.length,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    network: 'stellar:testnet',
    x402: true,
    features: ['payment', 'path_payment', 'chain', 'spending_policy', 'reputation', 'time_bounds'],
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
  console.log(`Features: x402, path payments, chain transactions, spending policies`);
});

export default app;
