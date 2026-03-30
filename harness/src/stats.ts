import fs from "node:fs";
import { TxResult } from "./scheduler.js";

interface AgentBreakdown {
  txCount: number;
  successCount: number;
  totalSpent: number;
}

interface StatsSnapshot {
  totalTxs: number;
  successRate: number;
  avgLatencyMs: number;
  uptimeMinutes: number;
  perAgent: Record<string, AgentBreakdown>;
  generatedAt: string;
}

export class StatsCollector {
  private allResults: TxResult[] = [];
  private startTime: Date = new Date();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  record(result: TxResult): void {
    this.allResults.push(result);
  }

  getStats(): StatsSnapshot {
    const totalTxs = this.allResults.length;
    const successCount = this.allResults.filter((r) => r.success).length;
    const successRate = totalTxs > 0 ? successCount / totalTxs : 0;
    const avgLatencyMs =
      totalTxs > 0
        ? Math.round(
            this.allResults.reduce((sum, r) => sum + r.latencyMs, 0) / totalTxs
          )
        : 0;

    const uptimeMinutes = Math.round(
      (Date.now() - this.startTime.getTime()) / 60000
    );

    const perAgent: Record<string, AgentBreakdown> = {};
    for (const r of this.allResults) {
      if (!perAgent[r.buyer]) {
        perAgent[r.buyer] = { txCount: 0, successCount: 0, totalSpent: 0 };
      }
      const entry = perAgent[r.buyer];
      entry.txCount++;
      if (r.success) {
        entry.successCount++;
        entry.totalSpent = parseFloat(
          (entry.totalSpent + r.amount).toFixed(4)
        );
      }
    }

    return {
      totalTxs,
      successRate: parseFloat(successRate.toFixed(4)),
      avgLatencyMs,
      uptimeMinutes,
      perAgent,
      generatedAt: new Date().toISOString(),
    };
  }

  startHourlyWrite(outputPath: string): void {
    this.writeStats(outputPath);
    this.intervalHandle = setInterval(() => {
      this.writeStats(outputPath);
    }, 3600000);
  }

  writeStats(outputPath: string): void {
    const stats = this.getStats();
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2), "utf-8");
    console.log(
      `[${new Date().toISOString()}] Stats written to ${outputPath} (${stats.totalTxs} txs)`
    );
  }

  stopHourlyWrite(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
