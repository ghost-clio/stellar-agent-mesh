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
    const normalTx = cron.schedule("*/5 * * * *", async () => {
      const { buyer, service } = this.pickRandomBuyerAndService();
      const result = await this.executeTransaction(
        buyer,
        service.id,
        service.price,
        `normal_${uuidv4().slice(0, 8)}`
      );
      this.onResult(result);
    });
    this.tasks.push(normalTx);

    // Big rejection every 12 hours
    const bigRejection = cron.schedule("0 */12 * * *", async () => {
      const { buyer, service } = this.pickRandomBuyerAndService();
      const result = await this.executeTransaction(
        buyer,
        service.id,
        10000.0,
        `rejection_test_${uuidv4().slice(0, 8)}`
      );
      this.onResult(result);
    });
    this.tasks.push(bigRejection);

    // Path payment every 8 hours
    const pathPayment = cron.schedule("0 */8 * * *", async () => {
      const { buyer, service } = this.pickRandomBuyerAndService();
      const result = await this.executeTransaction(
        buyer,
        service.id,
        service.price,
        `path_payment_${uuidv4().slice(0, 8)}`
      );
      this.onResult(result);
    });
    this.tasks.push(pathPayment);

    // Concurrent burst every 6 hours
    const concurrent = cron.schedule("0 */6 * * *", async () => {
      const promises: Promise<TxResult>[] = [];
      for (let i = 0; i < 3; i++) {
        const { buyer, service } = this.pickRandomBuyerAndService();
        promises.push(
          this.executeTransaction(
            buyer,
            service.id,
            service.price,
            `concurrent_${i}_${uuidv4().slice(0, 8)}`
          )
        );
      }
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === "fulfilled") {
          this.onResult(r.value);
        }
      }
    });
    this.tasks.push(concurrent);
  }

  /**
   * Find the seller agent for a given service ID.
   */
  private findSeller(serviceId: string): Agent | undefined {
    return this.agents.find(a => a.services.some(s => s.id === serviceId));
  }

  async executeTransaction(
    buyer: Agent,
    serviceId: string,
    amount?: number,
    memo?: string
  ): Promise<TxResult> {
    const ts = new Date().toISOString();
    const txMemo = memo ?? `tx_${uuidv4().slice(0, 8)}`;
    const seller = this.findSeller(serviceId);

    // Apply +/-10% jitter to amount
    const baseAmount = amount ?? 1.0;
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    const finalAmount = parseFloat((baseAmount * jitter).toFixed(4));

    const start = performance.now();

    try {
      // Step 1: GET without proof → receive 402 with payment requirements
      let paymentReq: any = null;
      try {
        const res402 = await axios.get(`${this.gatewayUrl}/service/${serviceId}`, {
          headers: { "X-BUYER-ADDRESS": buyer.pubkey },
          validateStatus: (status) => status === 402,
        });
        if (res402.status === 402) {
          paymentReq = res402.data;
        }
      } catch {
        // continue regardless
      }

      // Step 2: Submit real Stellar payment (skip for amounts > spending policy to test rejection)
      let stellarTxHash: string | undefined;
      if (seller && finalAmount <= 500) {  // Only submit real tx within spending policy limits
        const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
        const sourceKeypair = StellarSdk.Keypair.fromSecret(buyer.secret);
        const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());

        const xlmAmount = finalAmount.toFixed(7); // Stellar requires 7 decimal places
        const memoText = txMemo.slice(0, 28); // Stellar memo limit

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: StellarSdk.Networks.TESTNET,
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: seller.pubkey,
              asset: StellarSdk.Asset.native(),
              amount: xlmAmount,
            })
          )
          .addMemo(StellarSdk.Memo.text(memoText))
          .setTimeout(30)
          .build();

        tx.sign(sourceKeypair);
        const result = await horizon.submitTransaction(tx);
        stellarTxHash = result.hash;
      }

      // Step 3: GET with real tx hash as proof
      const response = await axios.get(
        `${this.gatewayUrl}/service/${serviceId}`,
        {
          headers: {
            "X-BUYER-ADDRESS": buyer.pubkey,
            "X-PAYMENT-PROOF": stellarTxHash ?? `fallback_${uuidv4()}`,
            "X-PAYMENT-AMOUNT": String(finalAmount),
            "X-PAYMENT-MEMO": txMemo,
          },
          timeout: 60000,
        }
      );

      const latencyMs = Math.round(performance.now() - start);
      const success = response.status >= 200 && response.status < 300;

      console.log(
        `[${ts}] ${success ? "✓" : "✗"} | ${buyer.name} → ${seller?.name ?? "?"} | ${serviceId} | ${finalAmount} XLM | ${latencyMs}ms | tx: ${stellarTxHash?.slice(0, 12) ?? "none"}...`
      );

      return {
        success,
        latencyMs,
        buyer: buyer.name,
        seller: seller?.name,
        serviceId,
        amount: finalAmount,
        memo: txMemo,
        timestamp: ts,
        stellarTxHash,
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error";

      // Expected for spending policy rejections ($10K tests)
      const isExpectedRejection = finalAmount > 1000;

      console.log(
        `[${ts}] ${isExpectedRejection ? "🚫" : "ERR"} | ${buyer.name} → ${seller?.name ?? "?"} | ${serviceId} | ${finalAmount} XLM | ${latencyMs}ms | ${errorMsg.slice(0, 80)}`
      );

      return {
        success: false,
        latencyMs,
        buyer: buyer.name,
        seller: seller?.name,
        serviceId,
        amount: finalAmount,
        memo: txMemo,
        timestamp: ts,
        error: errorMsg,
      };
    }
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    console.log(`[${new Date().toISOString()}] Scheduler stopped.`);
  }

  private pickRandomBuyerAndService(): {
    buyer: Agent;
    service: AgentService;
  } {
    const buyerIdx = Math.floor(Math.random() * this.agents.length);
    const buyer = this.agents[buyerIdx];

    // Pick a service from a DIFFERENT agent
    const otherAgents = this.agents.filter((_, i) => i !== buyerIdx);
    const sellerIdx = Math.floor(Math.random() * otherAgents.length);
    const seller = otherAgents[sellerIdx];
    const serviceIdx = Math.floor(Math.random() * seller.services.length);
    const service = seller.services[serviceIdx];

    return { buyer, service };
  }
}
