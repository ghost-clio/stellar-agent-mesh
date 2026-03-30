import dotenv from "dotenv";
import axios from "axios";
import { agents } from "./agents.js";
import { Scheduler } from "./scheduler.js";
import { StatsCollector } from "./stats.js";

dotenv.config();

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3402";
const STATS_PATH = "./stats.json";

async function registerAgents(gatewayUrl: string): Promise<void> {
  for (const agent of agents) {
    for (const service of agent.services) {
      try {
        await axios.post(`${gatewayUrl}/register`, {
          id: service.id,
          seller: agent.pubkey,
          price: service.price,
          capability: service.capability,
          endpoint: service.endpoint,
        });
        console.log(
          `[${new Date().toISOString()}] Registered ${agent.name}/${service.id}`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(
          `[${new Date().toISOString()}] Failed to register ${agent.name}/${service.id}: ${msg}`
        );
      }
    }
  }
}

async function setSpendingPolicies(gatewayUrl: string): Promise<void> {
  for (const agent of agents) {
    try {
      await axios.post(`${gatewayUrl}/policy`, {
        agent: agent.pubkey,
        perTxLimit: 500,
        dailyLimit: 5000,
      });
      console.log(
        `[${new Date().toISOString()}] Policy set for ${agent.name} (perTx: 500, daily: 5000)`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[${new Date().toISOString()}] Failed to set policy for ${agent.name}: ${msg}`
      );
    }
  }
}

async function main(): Promise<void> {
  const stats = new StatsCollector();
  const scheduler = new Scheduler(GATEWAY_URL, agents, (result) =>
    stats.record(result)
  );

  // Register all agents and their services on the gateway
  await registerAgents(GATEWAY_URL);

  // Set spending policies
  await setSpendingPolicies(GATEWAY_URL);

  // Start the scheduler
  scheduler.start();

  // Start hourly stats writing
  stats.startHourlyWrite(STATS_PATH);

  const totalServices = agents.reduce(
    (sum, a) => sum + a.services.length,
    0
  );
  console.log(
    `[${new Date().toISOString()}] Stellar Agent Mesh Battle Harness running | ${agents.length} agents | ${totalServices} services | gateway: ${GATEWAY_URL}`
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[${new Date().toISOString()}] Shutting down...`);
    scheduler.stop();
    stats.stopHourlyWrite();
    stats.writeStats(STATS_PATH);
    console.log(`[${new Date().toISOString()}] Final stats written. Goodbye.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
