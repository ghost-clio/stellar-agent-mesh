import { ServiceEntry, RepEntry, PolicyEntry } from './types.js';

class InMemoryRegistry {
  private services: Map<string, ServiceEntry> = new Map();
  private reputations: Map<string, RepEntry> = new Map();
  private policies: Map<string, PolicyEntry> = new Map();
  private dailySpend: Map<string, { amount: number; date: string }> = new Map();

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
  confirmSpend(agent: string, amount: number): void {
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.dailySpend.get(agent);
    let spent = 0;
    if (daily && daily.date === today) {
      spent = daily.amount;
    }
    this.dailySpend.set(agent, { amount: spent + amount, date: today });
  }

  getEffectivePrice(serviceId: string, buyerAddress: string): number {
    const service = this.getService(serviceId);
    if (!service) {
      return 0;
    }

    const rep = this.getReputation(buyerAddress);
    const repPercent =
      rep.txCount > 0
        ? Math.floor((rep.successCount / rep.txCount) * 100)
        : 0;
    const discount = Math.min(repPercent, 20);
    return service.price * (100 - discount) / 100;
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
