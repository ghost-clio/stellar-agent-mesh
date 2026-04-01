# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, pay via x402 or MPP, enforce spending policies, and settle in under 5 seconds — all on real Stellar rails.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## The Problem

AI agents need to pay each other for services. Current solutions build payment clients OR payment-accepting servers. Nobody builds the **mesh** — infrastructure where any agent is both buyer and seller, with discovery, governance, identity, and funding built in.

The missing pieces aren't payments. They're everything around payments: How does Susan the tutor fund her agent with a credit card? How does Dave the CISO set spending limits across 87 agents? How does an agent know which sellers to avoid? How does anyone see what their agent spent last month?

## The Solution

Stellar Agent Mesh is a protocol-agnostic payment gateway that any agent framework can plug into via HTTP. One process handles service discovery, dual-protocol payments (x402 + MPP), federation identity, spending governance, fiat on-ramp, fleet management, and audit logging.

```
┌──────────────────────────────────────────────────┐
│            SOROBAN REGISTRY CONTRACT              │
│   Service listings · Reliability · Spending rules │
└──────────────┬───────────────────────────────────┘
               │
    ┌──────────▼──────────┐  ┌─────────────────────┐
    │   EXPRESS GATEWAY    │  │  OPENCLAW SKILL      │
    │                      │  │                      │
    │   x402 + MPP dual    │  │  Agents install it   │
    │   Federation (SEP-2) │  │  and become economic  │
    │   SEP-24 fiat on-ramp│  │  actors instantly     │
    │   Spending governance│  │                      │
    │   Fleet admin (RBAC) │  │  Teaches agents HOW   │
    │   Blocklist + alerts │  │  to think about money │
    │   Fiat display (USD) │  │                      │
    │   CSV audit export   │  │                      │
    └──────────┬──────────┘  └─────────────────────┘
               │
    ┌──────────▼───────────────────────────────────┐
    │    BATTLE HARNESS (separate repo)             │
    │  4 AI agents · 16 economic scenarios          │
    │  github.com/ghost-clio/stellar-agent-mesh-harness │
    └──────────────────────────────────────────────┘
```

## Who This Is For

**Susan** (non-technical) — Deposits $20 via credit card (SEP-24). Her agent pays for services. She sees spending in dollars. She says "block that vendor" and it's done. She never sees XLM, gas fees, or wallet addresses.

**You** (developer) — Install the skill, point at a gateway, your agent can discover and pay for services. Send XLM directly. Price services in any Stellar asset. Path payments handle conversion.

**Dave** (fleet operator) — Set default spending policies across all agents. Admin dashboard shows fleet-wide spending. Rate limits prevent rogue agents from hammering the gateway. CSV export feeds the SIEM.

## Features

### Payments
| Feature | Description |
|---------|-------------|
| **x402 Payments** | HTTP 402 → pay → verify → deliver. Native XLM settlement. |
| **MPP Payments** | Session-based alternative. Expiry, cleanup, receipts. |
| **Path Payments** | Pay in any asset, seller receives their preferred one. Stellar DEX handles conversion. |
| **Asset-agnostic pricing** | Services declare price + asset (`native`, `USDC`, `EURC`, anything). |
| **Contacts + Send** | `send alice 50` — look up by name, resolve federation, pay. Venmo-simple. |

### Identity
| Feature | Description |
|---------|-------------|
| **Federation (SEP-2)** | `alice*devshop.agent` instead of `GABCDEF...` |
| **Contact list** | Map human names to federation addresses. Local, never leaves your machine. |

### Governance
| Feature | Description |
|---------|-------------|
| **Spending policies** | Per-tx and daily limits. 403 rejection with policy details. |
| **Default policies** | Fleet-wide fallback for all agents without custom limits. |
| **Blocklist** | Block bad sellers. Enforced at payment time. |
| **Spend alerts** | Webhook fires at configurable % of daily budget (default 80%). |
| **Rate limiting** | Per-agent max tx/minute. 429 on breach. |

### Observability
| Feature | Description |
|---------|-------------|
| **Spending dashboard** | Per-agent: total, by-service, by-day, recent txs. Header-authenticated — you only see your own data. |
| **Fiat display** | All prices and spending in USD (CoinGecko, 5min cache). Optional — crypto natives see XLM. |
| **Admin fleet view** | All agents sorted by today's spend. Admin-key protected. |
| **Txlog with filtering** | `?since=2026-03-01&until=2026-04-01&format=csv` for compliance/SIEM. |
| **Reliability tracking** | Per-agent success/failure counts. Honest failure log, not ratings. |
| **Persistent JSONL logs** | Append-only, survive restarts. |

### Funding
| Feature | Description |
|---------|-------------|
| **SEP-24 fiat on-ramp** | Credit card → XLM in your agent's wallet. Susan clicks a link, pays, done. |
| **Direct deposit** | Send XLM on-chain to the agent's address. For crypto natives. |
| **No forced flow** | The mesh doesn't care how XLM arrives. Balance > 0 = you can transact. |

### Security
| Feature | Description |
|---------|-------------|
| **Payment-based auth** | Signed Stellar transactions ARE proof of identity. No separate auth layer. |
| **60s time bounds** | All txs expire in 60 seconds. Replay protection. |
| **Zero axios** | Gateway uses native `fetch`. No supply chain attack surface. |
| **Enforcement order** | Rate limit (429) → Blocklist (403) → Spending policy (403) → Payment |

## Payment Flow

```
Agent A needs code review from Agent B:

1. GET /discover?capability=code-review
   ← [{id: "sage-review", price: 1.75, asset: "native", priceUsd: "$0.18"}]

2. GET /service/sage-review
   ← 402 {amount: 1.75, asset: "native", recipient: "G...", memo: "x402_abc123"}

3. Agent A submits Stellar payment (1.75 XLM)

4. GET /service/sage-review  +  X-Payment-Proof: tx_hash
   ← 200 {data: "Code review results...", txVerified: true}
```

## Endpoints

### Services
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/register` | Register a service (price, asset, capability) |
| GET | `/discover?capability=X` | Find services with prices + USD |
| GET | `/service/:id` | x402 payment flow |

### Payments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/pay` | Direct XLM payment (supports federation names) |
| POST | `/path-pay` | Path payment via Stellar DEX |
| POST | `/mpp/session` | Create MPP session |
| POST | `/mpp/verify` | Verify MPP payment |

### Identity
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/federation?q=name*domain` | Resolve federation address |
| POST | `/federation/register` | Register a name |

### Governance
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/policy` | Set agent spending policy |
| POST | `/blocklist` | Block a seller |
| DELETE | `/blocklist` | Unblock a seller |
| GET | `/blocklist` | Your blocked sellers |
| POST | `/alert` | Set spend alert (threshold + webhook) |
| GET | `/alert/check` | Check alert status |

### Observability
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/spending` | Your spending history (time-filtered, USD) |
| GET | `/stats/:address` | Agent reliability stats |
| GET | `/balance/:address` | XLM balance |
| GET | `/txlog` | Audit log (since/until/limit/csv) |
| GET | `/health` | System status |

### Funding
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/fund/anchors` | List SEP-24 fiat on-ramp providers |
| GET | `/fund/info?anchor=X` | Anchor's supported assets |
| POST | `/fund/deposit` | Start interactive deposit (returns URL) |
| GET | `/fund/status` | Check deposit completion |

### Admin (requires `X-ADMIN-KEY`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/spending` | Fleet spending overview |
| POST | `/admin/default-policy` | Set fleet-wide default policy |
| POST | `/admin/rate-limit` | Set per-agent rate limit |

## Components

| Component | Description |
|-----------|-------------|
| `gateway/` | Express server. x402 + MPP, federation, governance, funding. Zero axios. |
| `contracts/registry/` | Soroban contract (226 lines Rust). On-chain registry + reliability. |
| `skill/` | OpenClaw AgentSkill. Teaches agents the Stellar economic mental model. |
| [harness](https://github.com/ghost-clio/stellar-agent-mesh-harness) | Separate repo. 4 AI agents, 16 patterns, proves the infra works. |

## Quick Start

```bash
git clone https://github.com/ghost-clio/stellar-agent-mesh.git
cd stellar-agent-mesh/gateway
npm install
cp .env.example .env    # Configure Stellar keys
npx tsc && node dist/index.js
# Gateway running on http://localhost:3402
```

## Why Stellar

- **$0.00000003 per tx** — agents can transact millions of times
- **< 5s finality** — real-time service delivery
- **Path payments** — native multi-asset conversion via DEX
- **Federation (SEP-2)** — human-readable addresses built into the protocol
- **SEP-24** — fiat on-ramp standard, credit cards to XLM
- **Built for payments** — not compute, not speed, payments

## What's Working

- Full x402 + MPP dual protocol with real Stellar transactions
- Federation, path payments, spending policies, blocklist, alerts, rate limiting
- Fiat display (USD), admin fleet view, CSV audit export
- SEP-24 fiat on-ramp integration
- Asset-agnostic service pricing
- Contacts + Venmo-style send by name
- Soroban contract on testnet
- 54 tests passing
- [Battle harness](https://github.com/ghost-clio/stellar-agent-mesh-harness): 16 patterns, 4 Nemotron agents, persistent tx logs

## Limitations

- Federation is in-memory (production: stellar.toml + HTTPS callback)
- MPP sessions are in-memory (production: Redis)
- Path payment tests use XLM→XLM (testnet lacks diverse liquidity)
- Soroban interactions are gateway-mediated
- Secret keys in harness request bodies (testnet — production uses wallet signing)

## License

Apache-2.0
