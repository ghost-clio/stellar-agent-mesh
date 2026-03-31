import cron, { ScheduledTask } from "node-cron";
import axios from "axios";
import * as StellarSdk from "@stellar/stellar-sdk";
import { v4 as uuidv4 } from "uuid";
import { Agent, AgentService } from "./agents.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

export interface TxResult {
  success: boolean;
  latencyMs: number;
  buyer: string;
  seller?: string;
  serviceId: string;
  amount: number;
  memo: string;
  timestamp: string;
  stellarTxHash?: string;
  type: "payment" | "path_payment" | "chain" | "rejection";
  error?: string;
}

export class Scheduler {
  private gatewayUrl: string;
  private agents: Agent[];
  private onResult: (result: TxResult) => void;
  private tasks: ScheduledTask[] = [];

  constructor(
    gatewayUrl: string,
    agents: Agent[],
    onResult: (result: TxResult) => void
  ) {
    this.gatewayUrl = gatewayUrl;
    this.agents = agents;
    this.onResult = onResult;
  }

  start(): void {
    // Normal transaction every 5 minutes
    this.tasks.push(
      cron.schedule("*/5 * * * *", async () => {
        const { buyer, service } = this.pickRandomBuyerAndService();
        const result = await this.executeTransaction(
          buyer, service.id, service.price, `normal_${uuidv4().slice(0, 8)}`
        );
        this.onResult(result);
      })
    );

    // Big rejection every 12 hours
    this.tasks.push(
      cron.schedule("0 */12 * * *", async () => {
        const { buyer, service } = this.pickRandomBuyerAndService();
        const result = await this.executeTransaction(
          buyer, service.id, 10000.0, `rejection_test_${uuidv4().slice(0, 8)}`
        );
        this.onResult(result);
      })
    );

    // Path payment every 8 hours (XLM→XLM via DEX)
    this.tasks.push(
      cron.schedule("0 */8 * * *", async () => {
        const { buyer, service } = this.pickRandomBuyerAndService();
        const result = await this.executePathPayment(
          buyer, service, `path_${uuidv4().slice(0, 8)}`
        );
        this.onResult(result);
      })
    );

    // Three-agent chain every 6 hours
    this.tasks.push(
      cron.schedule("0 */6 * * *", async () => {
        const results = await this.executeChainTransaction();
        for (const r of results) {
          this.onResult(r);
        }
      })
    );

    // Concurrent burst every 4 hours (3 simultaneous purchases)
    this.tasks.push(
      cron.schedule("0 */4 * * *", async () => {
        const promises: Promise<TxResult>[] = [];
        for (let i = 0; i < 3; i++) {
          const { buyer, service } = this.pickRandomBuyerAndService();
          promises.push(
            this.executeTransaction(
              buyer, service.id, service.price, `concurrent_${i}_${uuidv4().slice(0, 8)}`
            )
          );
        }
        const results = await Promise.allSettled(promises);
        for (const r of results) {
          if (r.status === "fulfilled") this.onResult(r.value);
        }
      })
    );
  }

  /**
   * Find the seller agent for a given service ID.
   */
  private findSeller(serviceId: string): Agent | undefined {
    return this.agents.find(a => a.services.some(s => s.id === serviceId));
  }

  /**
   * Standard payment transaction with real Stellar testnet tx
   */
  async executeTransaction(
    buyer: Agent,
    serviceId: string,
    amount?: number,
    memo?: string
  ): Promise<TxResult> {
    const ts = new Date().toISOString();
    const txMemo = memo ?? `tx_${uuidv4().slice(0, 8)}`;
    const seller = this.findSeller(serviceId);

    // Apply +/-10% jitter
    const baseAmount = amount ?? 1.0;
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    const finalAmount = parseFloat((baseAmount * jitter).toFixed(4));

    const start = performance.now();

    try {
      // Step 1: GET without proof → 402
      try {
        await axios.get(`${this.gatewayUrl}/service/${serviceId}`, {
          headers: { "X-BUYER-ADDRESS": buyer.pubkey },
          validateStatus: (status) => status === 402,
        });
      } catch { /* continue */ }

      // Step 2: Submit real Stellar payment (skip for amounts > spending policy)
      let stellarTxHash: string | undefined;
      if (seller && finalAmount <= 500) {
        const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
        const sourceKeypair = StellarSdk.Keypair.fromSecret(buyer.secret);
        const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: StellarSdk.Networks.TESTNET,
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: seller.pubkey,
              asset: StellarSdk.Asset.native(),
              amount: finalAmount.toFixed(7),
            })
          )
          .addMemo(StellarSdk.Memo.text(txMemo.slice(0, 28)))
          .setTimeout(60) // Time bounds: 60s
          .build();

        tx.sign(sourceKeypair);
        const result = await horizon.submitTransaction(tx);
        stellarTxHash = result.hash;
      }

      // Step 3: GET with proof
      const response = await axios.get(
        `${this.gatewayUrl}/service/${serviceId}`,
        {
          headers: {
            "X-BUYER-ADDRESS": buyer.pubkey,
            "X-PAYMENT-PROOF": stellarTxHash ?? `fallback_${uuidv4()}`,
            "X-PAYMENT-AMOUNT": String(finalAmount),
          },
          timeout: 60000,
        }
      );

      const latencyMs = Math.round(performance.now() - start);
      const success = response.status >= 200 && response.status < 300;

      console.log(
        `[${ts}] ✓ | ${buyer.name} → ${seller?.name ?? "?"} | ${serviceId} | ${finalAmount} XLM | ${latencyMs}ms | tx: ${stellarTxHash?.slice(0, 12) ?? "none"}...`
      );

      return {
        success, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId, amount: finalAmount, memo: txMemo, timestamp: ts,
        stellarTxHash, type: "payment",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      const isExpectedRejection = finalAmount > 1000;

      console.log(
        `[${ts}] ${isExpectedRejection ? "🚫" : "ERR"} | ${buyer.name} → ${seller?.name ?? "?"} | ${serviceId} | ${finalAmount} XLM | ${latencyMs}ms | ${errorMsg.slice(0, 80)}`
      );

      return {
        success: false, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId, amount: finalAmount, memo: txMemo, timestamp: ts,
        error: errorMsg, type: isExpectedRejection ? "rejection" : "payment",
      };
    }
  }

  /**
   * Path payment — buyer pays XLM, DEX routes to seller
   */
  async executePathPayment(
    buyer: Agent,
    service: AgentService,
    memo: string
  ): Promise<TxResult> {
    const ts = new Date().toISOString();
    const seller = this.findSeller(service.id);
    const start = performance.now();

    try {
      const result = await axios.post(`${this.gatewayUrl}/path-pay`, {
        senderSecret: buyer.secret,
        destination: seller?.pubkey,
        destAmount: service.price.toFixed(7),
        maxSend: (service.price * 1.5).toFixed(7), // 50% slippage tolerance
        memo,
      });

      const latencyMs = Math.round(performance.now() - start);

      console.log(
        `[${ts}] 🔀 PATH | ${buyer.name} → ${seller?.name ?? "?"} | ${service.id} | ${service.price} XLM | ${latencyMs}ms | tx: ${result.data.hash?.slice(0, 12)}...`
      );

      return {
        success: true, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price, memo, timestamp: ts,
        stellarTxHash: result.data.hash, type: "path_payment",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      console.log(
        `[${ts}] ERR PATH | ${buyer.name} → ${seller?.name ?? "?"} | ${service.id} | ${errorMsg.slice(0, 80)}`
      );

      return {
        success: false, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price, memo, timestamp: ts,
        error: errorMsg, type: "path_payment",
      };
    }
  }

  /**
   * Three-agent chain: A→B→C with sequential payments
   */
  async executeChainTransaction(): Promise<TxResult[]> {
    const ts = new Date().toISOString();

    // Pick 3 different agents
    const shuffled = [...this.agents].sort(() => Math.random() - 0.5);
    const [a, b, c] = shuffled.slice(0, 3);
    const bService = b.services[0];
    const cService = c.services[0];

    const start = performance.now();

    try {
      const result = await axios.post(`${this.gatewayUrl}/chain`, {
        hops: [
          { senderSecret: a.secret, destination: b.pubkey, amount: bService.price.toFixed(7), serviceId: bService.id },
          { senderSecret: b.secret, destination: c.pubkey, amount: cService.price.toFixed(7), serviceId: cService.id },
        ],
      });

      const totalLatency = Math.round(performance.now() - start);
      const chainData = result.data;

      console.log(
        `[${ts}] ⛓️ CHAIN | ${a.name}→${b.name}→${c.name} | ${chainData.hops} hops | ${totalLatency}ms | ${chainData.success ? "✓" : "✗"}`
      );

      return chainData.results.map((r: any, i: number) => ({
        success: r.success,
        latencyMs: r.latencyMs,
        buyer: i === 0 ? a.name : b.name,
        seller: i === 0 ? b.name : c.name,
        serviceId: i === 0 ? bService.id : cService.id,
        amount: parseFloat(r.amount),
        memo: `chain_${chainData.chainId}_${i}`,
        timestamp: ts,
        stellarTxHash: r.txHash,
        type: "chain" as const,
      }));
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.log(`[${ts}] ERR CHAIN | ${a.name}→${b.name}→${c.name} | ${errorMsg.slice(0, 80)}`);

      return [{
        success: false, latencyMs: Math.round(performance.now() - start),
        buyer: a.name, seller: b.name, serviceId: bService.id,
        amount: bService.price, memo: `chain_err`, timestamp: ts,
        error: errorMsg, type: "chain" as const,
      }];
    }
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    console.log(`[${new Date().toISOString()}] Scheduler stopped.`);
  }

  private pickRandomBuyerAndService(): { buyer: Agent; service: AgentService } {
    const buyerIdx = Math.floor(Math.random() * this.agents.length);
    const buyer = this.agents[buyerIdx];
    const otherAgents = this.agents.filter((_, i) => i !== buyerIdx);
    const sellerIdx = Math.floor(Math.random() * otherAgents.length);
    const seller = otherAgents[sellerIdx];
    const serviceIdx = Math.floor(Math.random() * seller.services.length);
    return { buyer, service: seller.services[serviceIdx] };
  }
}
