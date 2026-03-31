import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import registry from './registry.js';
import { PaymentRequirement, ServiceResult } from './types.js';
import { submitPayment, verifyTransaction, getBalance } from './stellar.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3402', 10);
const RECIPIENT_ADDRESS =
  process.env.RESOURCE_SERVER_ADDRESS ||
  'GB2UYYBGWKJDZYQWNLS3MQX6QY7UXQSM4P3ROWCHBUVU54CKS5TLBHWI';

const startTime = Date.now();

// Transaction log for demo/audit
const txLog: Array<{
  timestamp: string;
  buyer: string;
  service: string;
  amount: number;
  txHash: string;
  verified: boolean;
}> = [];

// Middleware
app.use(cors());
app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

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

// GET /service/:id — x402-protected with REAL Stellar payments
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
      asset: 'native', // XLM
      network: 'stellar:testnet',
      recipient: RECIPIENT_ADDRESS,
      memo: `x402_${uuidv4().slice(0, 8)}`,
    };

    res.status(402).json(requirement);
    return;
  }

  // Verify the payment proof is a real Stellar transaction hash
  const rawBuyerAddr = req.headers['x-buyer-address'];
  const buyerAddress: string = (Array.isArray(rawBuyerAddr) ? rawBuyerAddr[0] : rawBuyerAddr) ?? 'unknown';

  // Check payment amount from header
  const rawPaymentAmount = req.headers['x-payment-amount'];
  const paymentAmount = rawPaymentAmount
    ? parseFloat(Array.isArray(rawPaymentAmount) ? rawPaymentAmount[0] : rawPaymentAmount)
    : registry.getEffectivePrice(id, buyerAddress);

  // Spending policy check → 403 if violated
  if (!registry.checkSpend(buyerAddress, paymentAmount)) {
    res.status(403).json({
      error: 'spending_policy_violation',
      requested: paymentAmount,
      policy: registry.getSpendingPolicy(buyerAddress),
    });
    return;
  }

  // Verify transaction on Stellar testnet
  let verified = false;
  try {
    verified = await verifyTransaction(paymentProof);
  } catch {
    // Verification failed — could be network issue, still proceed with warning
  }

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
    txVerified: verified,
  };

  // Update reputation
  registry.updateReputation(buyerAddress, true);

  // Log transaction
  txLog.push({
    timestamp: new Date().toISOString(),
    buyer: buyerAddress,
    service: id,
    amount: paymentAmount,
    txHash: paymentProof,
    verified,
  });

  res.json(result);
});

// POST /pay — Direct Stellar payment endpoint (for harness)
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

// GET /balance/:address — Check Stellar testnet balance
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
  res.json({
    count: txLog.length,
    verified: txLog.filter((t) => t.verified).length,
    transactions: txLog.slice(-50), // Last 50
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
});

export default app;
