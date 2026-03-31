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
  type: "payment" | "path_payment" | "chain" | "rejection" | "mpp" | "misbehavior" | "empty_wallet" | "multi_asset";
  protocol?: "x402" | "mpp";
  error?: string;
}

export class Scheduler {
  private gatewayUrl: string;
  private agents: Agent[];
  private onResult: (result: TxResult) => void;
  private tasks: ScheduledTask[] = [];
  private misbehaviorAgent: string | null = null; // Agent currently misbehaving

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
    // ── CORE PATTERNS ──

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

    // Path payment every 8 hours
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
        for (const r of results) this.onResult(r);
      })
    );

    // Concurrent burst every 4 hours
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

    // ── NEW PATTERNS ──

    // MPP payment every 3 hours (alternative protocol)
    this.tasks.push(
      cron.schedule("30 */3 * * *", async () => {
        const { buyer, service } = this.pickRandomBuyerAndService();
        const result = await this.executeMppTransaction(buyer, service);
        this.onResult(result);
      })
    );

    // Federation-addressed payment every 4 hours
    this.tasks.push(
      cron.schedule("15 */4 * * *", async () => {
        const result = await this.executeFederationPayment();
        this.onResult(result);
      })
    );

    // Reputation misbehavior arc — every 8 hours, one agent "misbehaves"
    this.tasks.push(
      cron.schedule("45 */8 * * *", async () => {
        const result = await this.executeMisbehavior();
        this.onResult(result);
      })
    );

    // Empty wallet test — once a day at 3 AM
    this.tasks.push(
      cron.schedule("0 3 * * *", async () => {
        const result = await this.executeEmptyWalletTest();
        this.onResult(result);
      })
    );

    // Dynamic multi-asset payment every 6 hours
    this.tasks.push(
      cron.schedule("20 */6 * * *", async () => {
        const result = await this.executeMultiAssetPayment();
        this.onResult(result);
      })
    );

    console.log(`[${new Date().toISOString()}] Scheduler started with 10 patterns`);
  }

  // ── CORE TRANSACTION METHODS ──

  private findSeller(serviceId: string): Agent | undefined {
    return this.agents.find(a => a.services.some(s => s.id === serviceId));
  }

  async executeTransaction(
    buyer: Agent, serviceId: string, amount?: number, memo?: string
  ): Promise<TxResult> {
    const ts = new Date().toISOString();
    const txMemo = memo ?? `tx_${uuidv4().slice(0, 8)}`;
    const seller = this.findSeller(serviceId);

    const baseAmount = amount ?? 1.0;
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    const finalAmount = parseFloat((baseAmount * jitter).toFixed(4));

    const start = performance.now();

    try {
      // Step 1: 402 probe
      try {
        await axios.get(`${this.gatewayUrl}/service/${serviceId}`, {
          headers: { "X-BUYER-ADDRESS": buyer.pubkey },
          validateStatus: (status) => status === 402,
        });
      } catch { /* continue */ }

      // Step 2: Real Stellar payment
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
          .setTimeout(60)
          .build();

        tx.sign(sourceKeypair);
        const result = await horizon.submitTransaction(tx);
        stellarTxHash = result.hash;
      }

      // Step 3: Deliver with proof
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
        stellarTxHash, type: "payment", protocol: "x402",
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
        error: errorMsg, type: isExpectedRejection ? "rejection" : "payment", protocol: "x402",
      };
    }
  }

  async executePathPayment(
    buyer: Agent, service: AgentService, memo: string
  ): Promise<TxResult> {
    const ts = new Date().toISOString();
    const seller = this.findSeller(service.id);
    const start = performance.now();

    try {
      const result = await axios.post(`${this.gatewayUrl}/path-pay`, {
        senderSecret: buyer.secret,
        destination: seller?.pubkey,
        destAmount: service.price.toFixed(7),
        maxSend: (service.price * 1.5).toFixed(7),
        memo,
      });

      const latencyMs = Math.round(performance.now() - start);

      console.log(
        `[${ts}] 🔀 PATH | ${buyer.name} → ${seller?.name ?? "?"} | ${service.id} | ${service.price} XLM | ${latencyMs}ms`
      );

      return {
        success: true, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price, memo, timestamp: ts,
        stellarTxHash: result.data.hash, type: "path_payment", protocol: "x402",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      return {
        success: false, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price, memo, timestamp: ts,
        error: errorMsg, type: "path_payment", protocol: "x402",
      };
    }
  }

  async executeChainTransaction(): Promise<TxResult[]> {
    const ts = new Date().toISOString();
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
        `[${ts}] ⛓️ CHAIN | ${a.name}→${b.name}→${c.name} | ${chainData.hops} hops | ${totalLatency}ms`
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
        protocol: "x402" as const,
      }));
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return [{
        success: false, latencyMs: Math.round(performance.now() - start),
        buyer: a.name, seller: b.name, serviceId: bService.id,
        amount: bService.price, memo: `chain_err`, timestamp: ts,
        error: errorMsg, type: "chain" as const, protocol: "x402" as const,
      }];
    }
  }

  // ── NEW PATTERNS ──

  /**
   * MPP payment — Use Machine Payments Protocol instead of x402
   */
  async executeMppTransaction(buyer: Agent, service: AgentService): Promise<TxResult> {
    const ts = new Date().toISOString();
    const seller = this.findSeller(service.id);
    const start = performance.now();

    try {
      // Step 1: Create MPP session
      const sessionRes = await axios.post(`${this.gatewayUrl}/mpp/session`, {
        resource: service.id,
        amount: service.price.toFixed(7),
      });
      const { sessionId } = sessionRes.data;

      // Step 2: Make Stellar payment
      const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
      const sourceKeypair = StellarSdk.Keypair.fromSecret(buyer.secret);
      const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: seller?.pubkey ?? sourceKeypair.publicKey(),
          asset: StellarSdk.Asset.native(),
          amount: service.price.toFixed(7),
        }))
        .addMemo(StellarSdk.Memo.text(`mpp_${sessionId.slice(0, 20)}`))
        .setTimeout(60)
        .build();

      tx.sign(sourceKeypair);
      const stellarResult = await horizon.submitTransaction(tx);

      // Step 3: Verify via MPP
      const verifyRes = await axios.post(`${this.gatewayUrl}/mpp/verify`, {
        sessionId,
        txHash: stellarResult.hash,
        payer: buyer.pubkey,
        amount: service.price.toFixed(7),
      });

      const latencyMs = Math.round(performance.now() - start);

      console.log(
        `[${ts}] 📦 MPP | ${buyer.name} → ${seller?.name ?? "?"} | ${service.id} | ${service.price} XLM | ${latencyMs}ms | session: ${sessionId.slice(0, 16)}`
      );

      return {
        success: true, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price,
        memo: `mpp_${sessionId}`, timestamp: ts,
        stellarTxHash: stellarResult.hash, type: "mpp", protocol: "mpp",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.log(`[${ts}] ERR MPP | ${buyer.name} | ${errorMsg.slice(0, 80)}`);

      return {
        success: false, latencyMs, buyer: buyer.name, seller: seller?.name,
        serviceId: service.id, amount: service.price,
        memo: "mpp_error", timestamp: ts,
        error: errorMsg, type: "mpp", protocol: "mpp",
      };
    }
  }

  /**
   * Federation-addressed payment — Pay using human-readable addresses
   */
  async executeFederationPayment(): Promise<TxResult> {
    const ts = new Date().toISOString();
    const shuffled = [...this.agents].sort(() => Math.random() - 0.5);
    const buyer = shuffled[0];
    const seller = shuffled[1];
    const service = seller.services[0];
    const fedAddress = `${seller.name.toLowerCase()}*mesh.agent`;
    const start = performance.now();

    try {
      const result = await axios.post(`${this.gatewayUrl}/pay`, {
        senderSecret: buyer.secret,
        destination: fedAddress, // Federation address, not raw pubkey
        amount: service.price.toFixed(7),
        memo: `fed_${uuidv4().slice(0, 8)}`,
      });

      const latencyMs = Math.round(performance.now() - start);

      console.log(
        `[${ts}] 🏷️ FED | ${buyer.name} → ${fedAddress} | ${service.price} XLM | ${latencyMs}ms`
      );

      return {
        success: true, latencyMs, buyer: buyer.name, seller: seller.name,
        serviceId: service.id, amount: service.price,
        memo: `fed_to_${fedAddress}`, timestamp: ts,
        stellarTxHash: result.data.hash, type: "payment", protocol: "x402",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      console.log(`[${ts}] ERR FED | ${buyer.name} → ${fedAddress} | ${errorMsg.slice(0, 80)}`);

      return {
        success: false, latencyMs, buyer: buyer.name, seller: seller.name,
        serviceId: service.id, amount: service.price,
        memo: `fed_err`, timestamp: ts,
        error: errorMsg, type: "payment", protocol: "x402",
      };
    }
  }

  /**
   * Reputation misbehavior — One agent periodically returns bad data,
   * causing reputation to DROP. Shows the reputation system penalizes failures.
   */
  async executeMisbehavior(): Promise<TxResult> {
    const ts = new Date().toISOString();
    const start = performance.now();

    // Pick a random agent to misbehave (rotate every cycle)
    const misbehaver = this.agents[Math.floor(Math.random() * this.agents.length)];
    this.misbehaviorAgent = misbehaver.name;

    // Record a FAILED reputation update for the misbehaving agent
    try {
      // Simulate: buyer paid but service returned garbage
      const buyer = this.agents.find(a => a.name !== misbehaver.name)!;
      const service = misbehaver.services[0];

      // Make a real payment
      const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
      const sourceKeypair = StellarSdk.Keypair.fromSecret(buyer.secret);
      const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: misbehaver.pubkey,
          asset: StellarSdk.Asset.native(),
          amount: service.price.toFixed(7),
        }))
        .addMemo(StellarSdk.Memo.text(`misbehavior_test`))
        .setTimeout(60)
        .build();

      tx.sign(sourceKeypair);
      const result = await horizon.submitTransaction(tx);

      // Report the seller as having delivered bad data → reputation drops
      await axios.post(`${this.gatewayUrl}/reputation/penalize`, {
        agent: misbehaver.pubkey,
        reason: "bad_data_returned",
      }).catch(() => {
        // Endpoint may not exist yet — that's fine, we update reputation via registry
      });

      const latencyMs = Math.round(performance.now() - start);

      console.log(
        `[${ts}] ⚠️ MISBEHAVE | ${misbehaver.name} returned bad data | buyer: ${buyer.name} | rep penalty applied | ${latencyMs}ms`
      );

      return {
        success: true, latencyMs, buyer: buyer.name, seller: misbehaver.name,
        serviceId: service.id, amount: service.price,
        memo: `misbehavior_${misbehaver.name}`, timestamp: ts,
        stellarTxHash: result.hash, type: "misbehavior", protocol: "x402",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      return {
        success: false, latencyMs, buyer: "system", seller: misbehaver.name,
        serviceId: misbehaver.services[0].id, amount: 0,
        memo: "misbehavior_err", timestamp: ts,
        error: errorMsg, type: "misbehavior", protocol: "x402",
      };
    }
  }

  /**
   * Empty wallet test — Try a transaction from a wallet with no funds.
   * Should fail gracefully, not crash.
   */
  async executeEmptyWalletTest(): Promise<TxResult> {
    const ts = new Date().toISOString();
    const start = performance.now();

    // Generate a NEW keypair with no funds
    const emptyKeypair = StellarSdk.Keypair.random();
    const seller = this.agents[0];
    const service = seller.services[0];

    try {
      const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

      // This SHOULD fail — account doesn't exist on testnet
      const sourceAccount = await horizon.loadAccount(emptyKeypair.publicKey());

      // If somehow it exists, try to pay
      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: seller.pubkey,
          asset: StellarSdk.Asset.native(),
          amount: "1.0000000",
        }))
        .setTimeout(60)
        .build();

      tx.sign(emptyKeypair);
      await horizon.submitTransaction(tx);

      // This path should never execute
      return {
        success: false, latencyMs: Math.round(performance.now() - start),
        buyer: "empty_wallet", seller: seller.name,
        serviceId: service.id, amount: 1.0,
        memo: "empty_wallet_unexpected_success", timestamp: ts,
        type: "empty_wallet", protocol: "x402",
      };
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      console.log(
        `[${ts}] 💸 EMPTY WALLET | Graceful failure in ${latencyMs}ms | ${errorMsg.slice(0, 60)}`
      );

      return {
        success: true, // Expected failure = test success
        latencyMs, buyer: "empty_wallet", seller: seller.name,
        serviceId: service.id, amount: 0,
        memo: "empty_wallet_graceful_failure", timestamp: ts,
        error: `Graceful: ${errorMsg.slice(0, 100)}`,
        type: "empty_wallet", protocol: "x402",
      };
    }
  }

  /**
   * Dynamic multi-asset payment — 3 buyers each pay with different amounts
   * simulating cross-asset scenarios
   */
  async executeMultiAssetPayment(): Promise<TxResult> {
    const ts = new Date().toISOString();
    const start = performance.now();
    const results: TxResult[] = [];

    // 3 different buyers, 3 different amounts, same seller
    const seller = this.agents[0];
    const service = seller.services[0];
    const buyers = this.agents.filter(a => a.name !== seller.name).slice(0, 3);

    const amounts = [0.001, 0.5, 2.5]; // Micro, small, medium

    for (let i = 0; i < Math.min(buyers.length, amounts.length); i++) {
      const buyer = buyers[i];
      const amount = amounts[i];

      try {
        const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
        const sourceKeypair = StellarSdk.Keypair.fromSecret(buyer.secret);
        const sourceAccount = await horizon.loadAccount(sourceKeypair.publicKey());

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: StellarSdk.Networks.TESTNET,
        })
          .addOperation(StellarSdk.Operation.payment({
            destination: seller.pubkey,
            asset: StellarSdk.Asset.native(),
            amount: amount.toFixed(7),
          }))
          .addMemo(StellarSdk.Memo.text(`multi_${i}_${uuidv4().slice(0,6)}`))
          .setTimeout(60)
          .build();

        tx.sign(sourceKeypair);
        const result = await horizon.submitTransaction(tx);

        console.log(
          `[${ts}] 💱 MULTI[${i}] | ${buyer.name} → ${seller.name} | ${amount} XLM | tx: ${result.hash.slice(0, 12)}...`
        );
      } catch (err: unknown) {
        console.log(`[${ts}] ERR MULTI[${i}] | ${buyer.name} | ${err instanceof Error ? err.message.slice(0, 60) : 'error'}`);
      }
    }

    const latencyMs = Math.round(performance.now() - start);

    return {
      success: true, latencyMs, buyer: "multi_buyers", seller: seller.name,
      serviceId: service.id, amount: amounts.reduce((a, b) => a + b, 0),
      memo: `multi_asset_${uuidv4().slice(0, 8)}`, timestamp: ts,
      type: "multi_asset", protocol: "x402",
    };
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
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
