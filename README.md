# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, negotiate prices, pay via x402 micropayments, build on-chain reputation, and enforce autonomous spending policies — all settled on Stellar in under 5 seconds.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## The Problem

AI agents need to pay each other for services. Current solutions build one-off payment clients OR payment-accepting servers. Nobody builds the **mesh** — infrastructure that makes any agent both buyer and seller simultaneously, with discovery, reputation, and governance built in.

## The Solution

Stellar Agent Mesh is a four-layer stack:

```
┌──────────────────────────────────────────────────┐
│              SOROBAN REGISTRY CONTRACT            │
│     Service listings · Reputation · Spending      │
│     policies · Discovery · Event emission         │
└─────────────┬───────────────────┬────────────────┘
              │                   │
    ┌─────────▼─────────┐  ┌─────▼──────────────┐
    │   EXPRESS GATEWAY  │  │  OPENCLAW SKILL     │
    │   x402 payment     │  │  Install = instant  │
    │   flow (402→pay    │  │  Stellar economic   │
    │   →verify→deliver) │  │  actor              │
    └─────────┬─────────┘  └──────────────────────┘
              │
    ┌─────────▼─────────────────────────────────────┐
    │             BATTLE HARNESS                     │
    │  4 autonomous AI agents transacting 24/7       │
    │                                                │
    │  Atlas (data)  ←→  Sage (code)                 │
    │  Pixel (creative) ←→ Quant (math)              │
    │                                                │
    │  Normal buys · $10K rejections · Path payments  │
    │  Concurrent bursts · Empty wallet tests         │
    └────────────────────────────────────────────────┘
```

## How It Works

### The x402 Payment Flow

```
Agent A                    Gateway                    Agent B
   │                         │                          │
   ├── GET /service/xyz ────►│                          │
   │                         │◄── 402 Payment Required  │
   │◄── {amount, asset,     │                          │
   │     recipient, memo}    │                          │
   │                         │                          │
   ├── Stellar payment ──────┼──────────────────────────┤
   │   (USDC, memo-bound)   │                          │
   │                         │                          │
   ├── GET /service/xyz ────►│                          │
   │   + X-Payment-Proof     │── Forward request ──────►│
   │                         │◄── Service response ─────┤
   │◄── 200 + response      │                          │
   │   + reputation update   │                          │
```

### Spending Policies

Agents set autonomous financial governance:
- **Per-transaction limit**: Max spend per single request
- **Daily limit**: Rolling 24h spending cap
- Violations emit `SpendingPolicyViolation` events and return `403`

```
Atlas: "Buy me a code review" → $1.70 → ✅ Approved
Atlas: "Buy me everything"   → $10,000 → ❌ 403 Policy Violation
```

### Reputation-Based Pricing

Service prices decrease as buyer reputation improves:
- Formula: `effective_price = base_price × (100 - min(rep%, 20)) / 100`
- Maximum 20% discount at 100% success rate
- Tracked per-agent on Soroban contract

## Components

| Component | Description | Tech |
|-----------|-------------|------|
| `contracts/registry/` | Service registry + reputation + spending policies | Rust, soroban-sdk v22 |
| `gateway/` | x402 payment gateway with service forwarding | TypeScript, Express |
| `skill/` | OpenClaw AgentSkill — install and go | Shell scripts |
| `harness/` | 4 autonomous AI agents transacting on cron | TypeScript, Nemotron |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ghost-clio/stellar-agent-mesh.git
cd stellar-agent-mesh

# 2. Install dependencies
npm install
cd gateway && npm install && cd ..
cd harness && npm install && cd ..

# 3. Configure
cp .env.example .env
# Edit .env with your OpenRouter API key (free tier works)

# 4. Run everything
bash start.sh

# Or test a single transaction cycle
cd gateway && npx tsc && node dist/index.js &
cd ../harness && npx tsc
OPENROUTER_API_KEY=your_key node dist/run-once.js
```

## Battle Harness

This isn't a demo. It's a living economy.

**4 agents**, each powered by Nemotron 120B (free on OpenRouter):

| Agent | Services | Personality |
|-------|----------|-------------|
| **Atlas** | Web search, News aggregation | Concise data analyst |
| **Sage** | Code review, Bug analysis | Senior software engineer |
| **Pixel** | Image description, Style transfer | Creative encyclopedist |
| **Quant** | Market data, Risk scoring | Quantitative analyst |

**Transaction patterns** (automated via cron):
- **Normal**: Every 5 min — random buyer purchases random service, ±10% price jitter
- **Rejection**: Every 12h — $10,000 request triggers spending policy violation (403)
- **Concurrent**: Every 6h — 3 simultaneous purchases stress-test the gateway
- **Path payment**: Every 8h — cross-asset payment simulation

### Verified Results

```
[1] Atlas → sage-code-review (normal)     ✅ 14692ms | $1.70
[2] Atlas → sage-code-review ($10K test)  ❌ 2ms     | $10291 | 403 spending_policy_violation
[3] Quant → pixel-style-transfer (cross)  ✅ 3244ms  | $0.79
```

Reputation after run: `{ txCount: 1, successCount: 1 }`

## OpenClaw Skill

Install the skill and any OpenClaw agent becomes a Stellar economic actor:

```bash
# Discover available services
echo '{"capability":"code-review"}' | ./skill/scripts/discover.sh

# Register your agent as a service provider
echo '{"id":"my-svc","seller":"G...","price":1.0,"capability":"translation","endpoint":"http://..."}' | ./skill/scripts/register.sh

# Check balance
./skill/scripts/balance.sh

# Check reputation
echo '{"address":"G..."}' | ./skill/scripts/reputation.sh
```

## Why Stellar

- **$0.00000003** per transaction (vs $0.50-50+ on Ethereum)
- **< 5 second** finality
- **Path payments**: Buyer pays in any asset, seller receives preferred asset
- **Soroban**: Smart contracts with predictable gas costs
- **Built for payments**: Not a general compute chain trying to do payments

## Cost to Run

| Component | Cost |
|-----------|------|
| Nemotron 120B (OpenRouter) | $0 (free tier) |
| Stellar testnet transactions | $0 (Friendbot) |
| Gateway hosting | $0 (runs locally) |
| **Total** | **$0** |

## License

Apache-2.0
