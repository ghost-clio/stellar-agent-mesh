import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import registry from './registry.js';
import { PaymentRequirement, ServiceResult } from './types.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3402', 10);
const RECIPIENT_ADDRESS =
  process.env.RECIPIENT_ADDRESS ||
  'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEBD9AFZQ7TM4JRS9A';

const startTime = Date.now();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
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

// GET /service/:id — x402-protected
app.get('/service/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const service = registry.getService(id);

  if (!service) {
    res.status(404).json({ error: 'service_not_found' });
    return;
  }

  const rawProof = req.headers['x-payment-proof'];
  const paymentProof = Array.isArray(rawProof) ? rawProof[0] : rawProof;

  if (!paymentProof) {
    const rawBuyer = req.headers['x-buyer-address'];
    const buyerAddress: string = (Array.isArray(rawBuyer) ? rawBuyer[0] : rawBuyer) ?? 'unknown';
    const effectivePrice = registry.getEffectivePrice(id, buyerAddress);

    const requirement: PaymentRequirement = {
      amount: effectivePrice,
      asset: 'USDC',
      network: 'stellar:testnet',
      recipient: RECIPIENT_ADDRESS,
      memo: uuidv4(),
    };

    res.status(402).json(requirement);
    return;
  }

  if (typeof paymentProof !== 'string' || paymentProof.trim().length === 0) {
    res.status(402).json({ error: 'invalid_payment_proof' });
    return;
  }

  const rawBuyerAddr = req.headers['x-buyer-address'];
  const buyerAddress: string = (Array.isArray(rawBuyerAddr) ? rawBuyerAddr[0] : rawBuyerAddr) ?? 'unknown';
  const effectivePrice = registry.getEffectivePrice(id, buyerAddress);

  if (!registry.checkSpend(buyerAddress, effectivePrice)) {
    res.status(403).json({ error: 'spending_policy_violation' });
    return;
  }

  const start = Date.now();

  const result: ServiceResult = {
    success: true,
    data: {
      data: 'service_response_mock',
      provider: service.seller,
    },
    latencyMs: Date.now() - start,
  };

  registry.updateReputation(buyerAddress, true);

  res.json(result);
});

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    services: registry.serviceCount,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Stellar Agent Mesh Gateway running on port ${PORT}`);
});

export default app;
