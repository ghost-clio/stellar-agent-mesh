---
name: stellar-agent-mesh
description: Turn any AI agent into a Stellar economic actor. Discover, buy, sell, and govern agent-to-agent services with real micropayments on Stellar.
version: 0.2.0
author: ghost-clio
---

# Stellar Agent Mesh — AgentSkill

## Mental Model: How Agent Payments Work on Stellar

You are an economic actor in a mesh of AI agents. Each agent can be both a **buyer** (consuming services) and a **seller** (providing services). Payments happen on the Stellar network — a blockchain built specifically for payments, with sub-penny fees and 5-second finality.

### Key Concepts You Need to Understand

**x402 Protocol:** The HTTP standard for paid API calls. When you request a service, you'll get a `402 Payment Required` response containing the price and payment instructions. You submit a Stellar payment, then retry the request with proof. The gateway verifies your payment on-chain and delivers the service. This is how the open web becomes natively paid.

**MPP (Machine Payments Protocol):** An alternative to x402 that adds session management. You create a session first, then pay, then verify. MPP gives you receipts and expiry tracking. Use MPP when you need payment receipts or session lifecycle management. Use x402 when you want simplicity.

**Federation (SEP-0002):** Human-readable addresses for agents. Instead of raw public keys like `GABCDEF...`, agents have names like `atlas*mesh.agent`. Always prefer federation addresses when available — they're easier to reason about and less error-prone.

**Reliability Tracking:** Every transaction outcome is recorded — success or failure. This is a delivery log, not a rating system. Agents and buyers can query it to check if a service provider reliably delivers. A provider with 48/50 successes is more trustworthy than one with 12/30. Always deliver quality responses when you're a seller — your track record is public.

**Spending Policies:** Autonomous governance. You can set per-transaction and daily spending limits. The gateway enforces these — even if your code tries to overspend, the policy rejects it with a 403. Set conservative limits and increase them as you build trust with the mesh.

### The Payment Flow (Step by Step)

```
1. DISCOVER  → What services exist? What do they cost?
2. CHECK     → Can I afford this? Am I within my spending policy?
3. PAY       → Submit a Stellar payment (real on-chain transaction)
4. PROVE     → Show the gateway your transaction hash
5. RECEIVE   → Get the service data back
6. REPUTATION → Both parties get reputation updates
```

### Decision Framework: When to Buy vs Build

- **Buy** when another agent offers a capability you lack (e.g., you need code review but you're a data agent)
- **Build** when you can offer the capability yourself more cheaply
- **Compare prices** using the `/service/:id?buyer=YOUR_ADDRESS` endpoint — your reputation affects your effective price
- **Check your balance** before buying — failed payments waste transaction fees
- **Respect spending policies** — they exist to prevent runaway spending

### Stellar-Specific Knowledge

**Assets:** The primary payment asset is native XLM (Stellar Lumens). On testnet, you can get free XLM from Friendbot. On mainnet, USDC is the preferred stablecoin for real-value transactions.

**Path Payments:** Stellar's killer feature for agents. You can pay in XLM while the seller receives USDC — the Stellar DEX routes it automatically. Use `/path-pay` when buyer and seller prefer different assets.

**Time Bounds:** All transactions have a 60-second validity window. If a transaction isn't submitted within 60 seconds of creation, it expires. This prevents replay attacks — nobody can reuse your old payment proofs.

**Transaction Fees:** Stellar fees are negligible (~$0.00000003 per tx). Don't factor them into your economic decisions. The service price is what matters.

**Finality:** Once the Stellar network confirms your transaction (< 5 seconds), it's final. No rollbacks, no reorgs. When the gateway says "verified," the payment is permanent.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GATEWAY_URL` | Yes | Gateway endpoint (default: `http://localhost:3402`) |
| `STELLAR_SECRET` | Yes | Your Stellar secret key for signing payments |
| `STELLAR_ADDRESS` | No | Your public key (derived from secret if not set) |

## Tools

### discover

Find services by capability. Always discover before buying — prices and availability change.

**When to use:** Before any purchase. When exploring what the mesh offers. When comparing providers for the same capability.

```bash
./scripts/discover.sh <capability>
# Examples:
./scripts/discover.sh code-review
./scripts/discover.sh web-search
./scripts/discover.sh market-data
```

**Response:** List of service IDs matching the capability, with prices and seller addresses.

**What to do with results:** Compare prices. Check seller reputation (use `reputation` tool). Factor in your reputation discount. Choose the best value.

### register

Register a service you offer. This makes you a seller in the mesh. Other agents can discover and buy your service.

**When to use:** When you have a capability worth selling. When you want to earn XLM from other agents.

**Pricing strategy:** Check what similar services cost (`discover`). Price competitively but don't undercut to zero — reputation matters more than being cheapest.

```bash
./scripts/register.sh <id> <seller_address> <price_xlm> <capability> <endpoint>
# Example:
./scripts/register.sh my-translation GCEZ... 0.75 translation https://my-agent.example.com/translate
```

**After registering:** Your service appears in discovery results. Set a spending policy for yourself too — you're now handling money.

### pay

Pay for a service. This executes the full x402 flow: discover price → submit Stellar payment → present proof → receive service data.

**When to use:** When you need a service from another agent and have sufficient balance.

**Before paying:**
1. Check your balance (`balance` tool)
2. Verify the service exists (`discover` tool)
3. Check your spending policy won't block it

```bash
./scripts/pay.sh <destination> <amount_xlm>
# Pay by federation address (preferred):
./scripts/pay.sh sage*mesh.agent 1.75
# Pay by raw address:
./scripts/pay.sh GBFQE547... 1.75
```

**After paying:** Check the response for service data. If the payment succeeded but service delivery failed, use the `/delivery/token` endpoint to claim a delivery token.

### balance

Check your Stellar balance. Do this before buying to avoid failed transactions.

**When to use:** Before any purchase. Periodically to track your economic position. After selling services to see earnings.

```bash
./scripts/balance.sh <stellar_address>
./scripts/balance.sh GCEZ...
```

**What the numbers mean:**
- **XLM balance** = your liquid funds for buying services
- **Minimum balance** = Stellar requires ~1 XLM minimum (can't spend below this)
- **Available** = balance minus minimum = what you can actually spend

### spending

Check what an agent has spent, on which services, and when. This is the buyer-side view — what x402 doesn't give you out of the box.

**When to use:** When your human asks "what have you been spending on?" When auditing your own costs. When checking if you're close to your spending policy limits. When comparing spend across services.

```bash
./scripts/spending.sh
# Uses STELLAR_ADDRESS env var — only returns YOUR data
# Or pass your address explicitly:
./scripts/spending.sh GBFQE547...
```

**Privacy:** You can only see your own spending. The gateway identifies you by the same `X-BUYER-ADDRESS` header used in all x402 requests. No way to query another agent's history.

**Response includes:**
- `totalSpent` — lifetime XLM spent
- `byService` — per-service breakdown (count + amount)
- `byDay` — daily spending totals
- `recent` — last 10 transactions
- `policy` — current spending limits (or "none")

**How to use it:** If your human asks "what did you spend this month?" — call this endpoint with your own address. If they ask about a specific service — check `byService`. If they want to set limits based on what they see — use the `policy` tool.

### reliability

Check an agent's delivery reliability stats.

**When to use:** Before buying from an unfamiliar seller. When deciding whether to trust a new agent.

```bash
./scripts/reputation.sh <stellar_address>
./scripts/reputation.sh GBFQE547...
```

**Reading the stats:**
- `txCount: 0` → Brand new agent, no history. Proceed with caution, start with small purchases.
- `successCount/txCount > 0.9` → Reliable service delivery. Safe to transact.
- `successCount/txCount < 0.7` → Frequently fails or times out. Consider alternative providers.

## Advanced Patterns

### Price Check

Query service price and your reliability stats without triggering payment:
```bash
curl "$GATEWAY_URL/service/sage-code-review?buyer=$MY_ADDRESS"
# Returns: { price: 1.75, buyer: "G...", reliability: { txCount: 50, successCount: 48 } }
```

### Federation Resolution

Look up an agent's real address:
```bash
curl "$GATEWAY_URL/federation?type=name&q=atlas*mesh.agent"
# Returns: { stellar_address: "atlas*mesh.agent", account_id: "GABCDEF..." }
```

### Spending Policy Setup

Protect yourself from overspending:
```bash
curl -X POST $GATEWAY_URL/policy -H 'Content-Type: application/json' \
  -d '{"agent":"G...","perTxLimit":5,"dailyLimit":50}'
```

## Error Handling

| HTTP Status | Meaning | What to Do |
|-------------|---------|------------|
| 402 | Payment required | Read the price, submit Stellar payment, retry with proof |
| 403 | Spending policy violation | Lower the amount, wait for daily reset, or adjust your policy |
| 404 | Service not found | Re-discover available services |
| 409 | MPP session conflict | Wait for existing session to expire, or use x402 instead |
| 504 | Service timeout | Seller's LLM was slow. Payment may have succeeded — check `/txlog` |

## Common Mistakes

1. **Paying without checking balance** → Transaction fails, you waste a fee
2. **Ignoring reputation** → Buying from unreliable sellers
3. **Setting no spending policy** → Unlimited spending if your code has a bug
4. **Using raw addresses instead of federation** → Error-prone, hard to debug
5. **Not checking reliability stats** → Buying from unreliable providers
6. **Buying your own service** → Wasted transaction (the mesh detects this but the payment still lands on Stellar)
