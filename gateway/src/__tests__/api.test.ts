import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// Minimal server setup for testing (avoids importing the full server which calls listen())
function createApp() {
  const services = new Map<string, any>();
  const reputations = new Map<string, { txCount: number; successCount: number }>();
  const policies = new Map<string, { perTxLimit: number; dailyLimit: number }>();
  const dailySpend = new Map<string, { amount: number; date: string }>();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post("/register", (req, res) => {
    const { id, seller, price, capability, endpoint } = req.body;
    if (!id || !seller || price == null || !capability || !endpoint) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    services.set(id, { id, seller, price, capability, endpoint });
    res.status(201).json({ registered: id });
  });

  app.get("/discover", (req, res) => {
    const capability = String(req.query.capability || "");
    if (!capability) {
      res.status(400).json({ error: "missing capability" });
      return;
    }
    const ids: string[] = [];
    for (const [id, entry] of services) {
      if (entry.capability === capability) ids.push(id);
    }
    res.json({ capability, services: ids });
  });

  app.get("/reputation/:address", (req, res) => {
    const address = req.params.address;
    const rep = reputations.get(address) ?? { txCount: 0, successCount: 0 };
    res.json({ address, ...rep });
  });

  app.post("/policy", (req, res) => {
    const { agent, perTxLimit, dailyLimit } = req.body;
    policies.set(agent, { perTxLimit, dailyLimit });
    res.json({ agent, perTxLimit, dailyLimit });
  });

  app.get("/service/:id", (req, res) => {
    const id = req.params.id;
    const service = services.get(id);
    if (!service) {
      res.status(404).json({ error: "service_not_found" });
      return;
    }

    const rawProof = req.headers["x-payment-proof"];
    const proof = Array.isArray(rawProof) ? rawProof[0] : rawProof;

    if (!proof) {
      res.status(402).json({
        amount: service.price,
        asset: "USDC",
        network: "stellar:testnet",
        recipient: "GTEST",
        memo: uuidv4(),
      });
      return;
    }

    // Check spending policy
    const rawBuyer = req.headers["x-buyer-address"];
    const buyer = (Array.isArray(rawBuyer) ? rawBuyer[0] : rawBuyer) ?? "unknown";
    const rawAmount = req.headers["x-payment-amount"];
    const amount = rawAmount ? parseFloat(Array.isArray(rawAmount) ? rawAmount[0] : rawAmount) : service.price;

    const policy = policies.get(buyer);
    if (policy && amount > policy.perTxLimit) {
      res.status(403).json({ error: "spending_policy_violation" });
      return;
    }

    // Update reputation
    const rep = reputations.get(buyer) ?? { txCount: 0, successCount: 0 };
    rep.txCount += 1;
    rep.successCount += 1;
    reputations.set(buyer, rep);

    res.json({ success: true, data: { capability: service.capability } });
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", services: services.size });
  });

  return app;
}

describe("Gateway API", () => {
  let server: ReturnType<typeof express.prototype.listen>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("health check returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe("ok");
  });

  it("registers a service", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-svc",
        seller: "GSELLER",
        price: 1.5,
        capability: "testing",
        endpoint: "http://localhost:9999",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.registered).toBe("test-svc");
  });

  it("rejects registration with missing fields", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("discovers services by capability", async () => {
    const res = await fetch(`${baseUrl}/discover?capability=testing`);
    const data = await res.json();
    expect(data.services).toContain("test-svc");
  });

  it("returns 402 without payment proof", async () => {
    const res = await fetch(`${baseUrl}/service/test-svc`);
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.amount).toBe(1.5);
    expect(data.asset).toBe("USDC");
    expect(data.network).toBe("stellar:testnet");
    expect(data.memo).toBeDefined();
  });

  it("returns 200 with payment proof", async () => {
    const res = await fetch(`${baseUrl}/service/test-svc`, {
      headers: {
        "X-PAYMENT-PROOF": "stellar_tx_abc123",
        "X-BUYER-ADDRESS": "GBUYER",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("returns 404 for unknown service", async () => {
    const res = await fetch(`${baseUrl}/service/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("returns 403 when spending policy violated", async () => {
    // Set policy with low limit
    await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "GRICH", perTxLimit: 100, dailyLimit: 1000 }),
    });

    const res = await fetch(`${baseUrl}/service/test-svc`, {
      headers: {
        "X-PAYMENT-PROOF": "stellar_tx_xyz",
        "X-BUYER-ADDRESS": "GRICH",
        "X-PAYMENT-AMOUNT": "500", // exceeds 100 per-tx limit
      },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("spending_policy_violation");
  });

  it("tracks reputation after successful transaction", async () => {
    const rep = await fetch(`${baseUrl}/reputation/GBUYER`);
    const data = await rep.json();
    expect(data.txCount).toBeGreaterThan(0);
    expect(data.successCount).toBeGreaterThan(0);
  });
});
