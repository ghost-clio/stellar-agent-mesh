import { ServiceEntry, RepEntry, PolicyEntry } from './types.js';

interface SpendRecord {
  serviceId: string;
  amount: number;
  timestamp: string;
}

class InMemoryRegistry {
  private services: Map<string, ServiceEntry> = new Map();
  private reputations: Map<string, RepEntry> = new Map();
  private policies: Map<string, PolicyEntry> = new Map();
  private dailySpend: Map<string, { amount: number; date: string }> = new Map();
  private spendLedger: Map<string, SpendRecord[]> = new Map();

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
      if (entry.capability === capability) {
        results.push(id);
      }
    }
    return results;
  }

  updateReputation(agent: string, success: boolean): void {
    const rep = this.getReputation(agent);
    rep.txCount += 1;
    if (success) {
      rep.successCount += 1;
    }
    this.reputations.set(agent, rep);
  }

  getReputation(agent: string): RepEntry {
    return this.reputations.get(agent) ?? { txCount: 0, successCount: 0 };
  }

  setSpendingPolicy(agent: string, perTxLimit: number, dailyLimit: number): void {
    this.policies.set(agent, { perTxLimit, dailyLimit });
  }

  /**
   * Check if a spend is within policy limits.
   * NOTE: Does NOT update daily spend — call confirmSpend() after payment succeeds.
   */
  checkSpend(agent: string, amount: number): boolean {
    const policy = this.policies.get(agent);
    if (!policy) {
      return true;
    }

    if (amount > policy.perTxLimit) {
      return false;
    }

    const today = new Date().toISOString().slice(0, 10);
    const daily = this.dailySpend.get(agent);

    let spent = 0;
    if (daily && daily.date === today) {
      spent = daily.amount;
    }

    if (spent + amount > policy.dailyLimit) {
      return false;
    }

    return true;
  }

  /**
   * Record a confirmed spend against daily limit.
   * Call this AFTER payment is verified, not during checkSpend.
   */
  confirmSpend(agent: string, amount: number, serviceId?: string): void {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const daily = this.dailySpend.get(agent);
    let spent = 0;
    if (daily && daily.date === today) {
      spent = daily.amount;
    }
    this.dailySpend.set(agent, { amount: spent + amount, date: today });

    // Record to spending ledger
    if (!this.spendLedger.has(agent)) {
      this.spendLedger.set(agent, []);
    }
    this.spendLedger.get(agent)!.push({
      serviceId: serviceId ?? 'unknown',
      amount,
      timestamp: now.toISOString(),
    });
  }

  getSpendingSummary(agent: string): {
    totalSpent: number;
    txCount: number;
    byService: Record<string, { count: number; spent: number }>;
    byDay: Record<string, number>;
    recent: SpendRecord[];
  } {
    const records = this.spendLedger.get(agent) ?? [];
    const byService: Record<string, { count: number; spent: number }> = {};
    const byDay: Record<string, number> = {};
    let totalSpent = 0;

    for (const r of records) {
      totalSpent += r.amount;

      if (!byService[r.serviceId]) {
        byService[r.serviceId] = { count: 0, spent: 0 };
      }
      byService[r.serviceId].count++;
      byService[r.serviceId].spent = parseFloat((byService[r.serviceId].spent + r.amount).toFixed(7));

      const day = r.timestamp.slice(0, 10);
      byDay[day] = parseFloat(((byDay[day] ?? 0) + r.amount).toFixed(7));
    }

    return {
      totalSpent: parseFloat(totalSpent.toFixed(7)),
      txCount: records.length,
      byService,
      byDay,
      recent: records.slice(-10),
    };
  }

  getPrice(serviceId: string): number {
    const service = this.getService(serviceId);
    return service?.price ?? 0;
  }

  getSpendingPolicy(agent: string): PolicyEntry | null {
    return this.policies.get(agent) ?? null;
  }

  get serviceCount(): number {
    return this.services.size;
  }
}

const registry = new InMemoryRegistry();
export default registry;
