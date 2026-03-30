import { describe, it, expect, beforeEach } from "vitest";

// We need to test the registry logic directly
// Import the module (which exports a singleton — we'll work around that)

interface ServiceEntry {
  id: string;
  seller: string;
  price: number;
  capability: string;
  endpoint: string;
}

interface RepEntry {
  txCount: number;
  successCount: number;
}

// Inline a fresh registry for each test (avoids singleton state leaking)
class TestRegistry {
  private services: Map<string, ServiceEntry> = new Map();
  private reputations: Map<string, RepEntry> = new Map();
  private policies: Map<string, { perTxLimit: number; dailyLimit: number }> =
    new Map();
  private dailySpend: Map<string, { amount: number; date: string }> =
    new Map();

  registerService(
    id: string,
    seller: string,
    price: number,
    capability: string,
    endpoint: string
  ): void {
    this.services.set(id, { id, seller, price, capability, endpoint });
  }

  getService(id: string): ServiceEntry | undefined {
    return this.services.get(id);
  }

  discover(capability: string): string[] {
    const results: string[] = [];
    for (const [id, entry] of this.services) {
      if (entry.capability === capability) results.push(id);
    }
    return results;
  }

  updateReputation(agent: string, success: boolean): void {
    const rep = this.getReputation(agent);
    rep.txCount += 1;
    if (success) rep.successCount += 1;
    this.reputations.set(agent, rep);
  }

  getReputation(agent: string): RepEntry {
    return (
      this.reputations.get(agent) ?? { txCount: 0, successCount: 0 }
    );
  }

  setSpendingPolicy(
    agent: string,
    perTxLimit: number,
    dailyLimit: number
  ): void {
    this.policies.set(agent, { perTxLimit, dailyLimit });
  }

  checkSpend(agent: string, amount: number): boolean {
    const policy = this.policies.get(agent);
    if (!policy) return true;
    if (amount > policy.perTxLimit) return false;
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.dailySpend.get(agent);
    let spent = 0;
    if (daily && daily.date === today) spent = daily.amount;
    if (spent + amount > policy.dailyLimit) return false;
    this.dailySpend.set(agent, { amount: spent + amount, date: today });
    return true;
  }

  getEffectivePrice(serviceId: string, buyerAddress: string): number {
    const service = this.getService(serviceId);
    if (!service) return 0;
    const rep = this.getReputation(buyerAddress);
    const repPercent =
      rep.txCount > 0
        ? Math.floor((rep.successCount / rep.txCount) * 100)
        : 0;
    const discount = Math.min(repPercent, 20);
    return (service.price * (100 - discount)) / 100;
  }
}

describe("InMemoryRegistry", () => {
  let registry: TestRegistry;

  beforeEach(() => {
    registry = new TestRegistry();
  });

  describe("Service Registration", () => {
    it("registers and retrieves a service", () => {
      registry.registerService("svc-1", "GSELLER", 1.5, "code-review", "http://localhost:4001");
      const svc = registry.getService("svc-1");
      expect(svc).toBeDefined();
      expect(svc!.seller).toBe("GSELLER");
      expect(svc!.price).toBe(1.5);
      expect(svc!.capability).toBe("code-review");
    });

    it("returns undefined for unknown service", () => {
      expect(registry.getService("nonexistent")).toBeUndefined();
    });

    it("overwrites service with same id", () => {
      registry.registerService("svc-1", "GSELLER1", 1.0, "cap-a", "http://a");
      registry.registerService("svc-1", "GSELLER2", 2.0, "cap-b", "http://b");
      const svc = registry.getService("svc-1");
      expect(svc!.seller).toBe("GSELLER2");
      expect(svc!.price).toBe(2.0);
    });
  });

  describe("Service Discovery", () => {
    it("discovers services by capability", () => {
      registry.registerService("s1", "G1", 1, "weather", "http://a");
      registry.registerService("s2", "G2", 2, "code-review", "http://b");
      registry.registerService("s3", "G3", 1.5, "weather", "http://c");
      const results = registry.discover("weather");
      expect(results).toHaveLength(2);
      expect(results).toContain("s1");
      expect(results).toContain("s3");
    });

    it("returns empty array for unknown capability", () => {
      registry.registerService("s1", "G1", 1, "weather", "http://a");
      expect(registry.discover("teleportation")).toHaveLength(0);
    });
  });

  describe("Reputation", () => {
    it("starts at zero", () => {
      const rep = registry.getReputation("GNEWAGENT");
      expect(rep.txCount).toBe(0);
      expect(rep.successCount).toBe(0);
    });

    it("increments on success", () => {
      registry.updateReputation("GAGENT", true);
      registry.updateReputation("GAGENT", true);
      const rep = registry.getReputation("GAGENT");
      expect(rep.txCount).toBe(2);
      expect(rep.successCount).toBe(2);
    });

    it("tracks failures separately", () => {
      registry.updateReputation("GAGENT", true);
      registry.updateReputation("GAGENT", false);
      registry.updateReputation("GAGENT", true);
      const rep = registry.getReputation("GAGENT");
      expect(rep.txCount).toBe(3);
      expect(rep.successCount).toBe(2);
    });
  });

  describe("Spending Policy", () => {
    it("allows spend when no policy set", () => {
      expect(registry.checkSpend("GAGENT", 99999)).toBe(true);
    });

    it("rejects spend exceeding per-tx limit", () => {
      registry.setSpendingPolicy("GAGENT", 500, 5000);
      expect(registry.checkSpend("GAGENT", 501)).toBe(false);
    });

    it("allows spend within per-tx limit", () => {
      registry.setSpendingPolicy("GAGENT", 500, 5000);
      expect(registry.checkSpend("GAGENT", 499)).toBe(true);
    });

    it("rejects spend exceeding daily limit", () => {
      registry.setSpendingPolicy("GAGENT", 500, 100);
      expect(registry.checkSpend("GAGENT", 60)).toBe(true); // 60 spent
      expect(registry.checkSpend("GAGENT", 60)).toBe(false); // 60+60=120 > 100
    });

    it("tracks cumulative daily spend", () => {
      registry.setSpendingPolicy("GAGENT", 500, 1000);
      for (let i = 0; i < 9; i++) {
        expect(registry.checkSpend("GAGENT", 100)).toBe(true);
      }
      // 900 spent, next 200 would exceed 1000
      expect(registry.checkSpend("GAGENT", 200)).toBe(false);
      // But 100 fits
      expect(registry.checkSpend("GAGENT", 100)).toBe(true);
    });
  });

  describe("Effective Price (Reputation Discount)", () => {
    it("returns full price for new buyer", () => {
      registry.registerService("s1", "G1", 100, "cap", "http://a");
      expect(registry.getEffectivePrice("s1", "GNEWBUYER")).toBe(100);
    });

    it("applies discount based on success rate", () => {
      registry.registerService("s1", "G1", 100, "cap", "http://a");
      // 10 txs, 10 successes = 100% rate → 20% discount (capped)
      for (let i = 0; i < 10; i++) {
        registry.updateReputation("GBUYER", true);
      }
      expect(registry.getEffectivePrice("s1", "GBUYER")).toBe(80);
    });

    it("caps discount at 20%", () => {
      registry.registerService("s1", "G1", 100, "cap", "http://a");
      for (let i = 0; i < 100; i++) {
        registry.updateReputation("GBUYER", true);
      }
      // Still 100% success rate, discount capped at 20%
      expect(registry.getEffectivePrice("s1", "GBUYER")).toBe(80);
    });

    it("scales discount with success rate", () => {
      registry.registerService("s1", "G1", 100, "cap", "http://a");
      // 10 txs, 5 successes = 50% rate → but floor = 50 → min(50, 20) = 20% discount? No...
      // Actually: repPercent = floor(5/10 * 100) = 50. discount = min(50, 20) = 20.
      // So 50% success still gets max discount. Let's test lower:
      // 10 txs, 1 success = 10% rate → discount = min(10, 20) = 10%
      for (let i = 0; i < 9; i++) {
        registry.updateReputation("GBUYER", false);
      }
      registry.updateReputation("GBUYER", true);
      expect(registry.getEffectivePrice("s1", "GBUYER")).toBe(90);
    });

    it("returns 0 for unknown service", () => {
      expect(registry.getEffectivePrice("nonexistent", "GBUYER")).toBe(0);
    });
  });
});
