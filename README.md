# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, negotiate prices, pay via x402 or MPP micropayments, build on-chain reputation, and enforce autonomous spending policies — all settled on Stellar in under 5 seconds.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## The Problem

AI agents need to pay each other for services. Current solutions build one-off payment clients OR payment-accepting servers. Nobody builds the **mesh** — infrastructure that makes any agent both buyer and seller simultaneously, with discovery, reputation, governance, and identity built in.

## The Solution

Stellar Agent Mesh is a five-layer stack:

```
┌───────────────────────────────────────────────────────┐
│              SOROBAN REGISTRY CONTRACT                 │
│     Service listings · Reputation · Spending policies  │
│     Discovery · Reputation-weighted pricing · Events   │
└──────────────┬────────────────────┬───────────────────┘
               │                    │
    ┌──────────▼──────────┐  ┌─────▼────────────────┐
    │   EXPRESS GATEWAY    │  │  OPENCLAW SKILL       │
    │   x402 + MPP dual    │  │  Install = instant    │
    │   protocol support   │  │  Stellar economic     │
    │   Federation (SEP-2) │  │  actor                │
    │   Web Auth (SEP-10)  │  │                       │
    │   JWT delivery       │  │                       │
    └──────────┬──────────┘  └────────────────────────┘
               │
    ┌──────────▼────────────────────────────────────────┐
    │             BATTLE HARNESS                         │
    │  4 AI agents transacting autonomously              │
    │                                                    │
    │  Atlas (data)  ←→  Sage (code)                     │
    │  Pixel (creative) ←→ Quant (math)                  │
    │                                                    │
    │  10 transaction patterns:                          │
    │  Normal · Rejection · Path · Chain · Concurrent    │
    │  MPP · Federation · Misbehavior · Empty wallet     │
    │  Multi-asset                                       │
    └───────────────────────────────────────────────────┘
```

## Features

| Feature | Description | Stellar Primitive |
|---------|-------------|-------------------|
| **x402 Payments** | HTTP 402 → pay → verify → deliver | Native XLM payments |
| **MPP Payments** | Machine Payments Protocol (session-based) | Alternative to x402 |
| **Path Payments** | Buyer pays any asset, seller receives preferred | `pathPaymentStrictReceive` |
| **Federation** | Human-readable addresses (`atlas*mesh.agent`) | SEP-0002 |
| **Web Auth** | Prove identity via signed challenge | SEP-0010 |
| **JWT Delivery** | Atomic paid delivery protection | HMAC-signed tokens |
| **Spending Policies** | Per-tx and daily limits with 403 rejection | Soroban contract |
| **Reputation** | On-chain scoring with misbehavior penalties | Soroban events |
| **Time Bounds** | Replay protection (60s expiry) | Transaction time bounds |
| **Chain Payments** | Multi-hop A→B→C sequential payments | Chained transactions |

## How It Works

### Dual Protocol Support (x402 + MPP)

```
── x402 Flow ──                    ── MPP Flow ──
GET /service/xyz                   POST /mpp/session
← 402 {amount, recipient}         ← {sessionId, amount}
                                   
Stellar payment                    Stellar payment
                                   
GET /service/xyz                   POST /mpp/verify
+ X-Payment-Proof: tx_hash        + {sessionId, txHash}
← 200 + data                      ← receipt + unlock
```

Agents choose their preferred protocol. The 402 response includes both options:

```json
{
  "amount": 0.50,
  "asset": "native",
  "network": "stellar:testnet",
  "protocols": {
    "x402": { "amount": 0.50, "recipient": "G...", "memo": "x402_abc123" },
    "mpp": { "sessionEndpoint": "/mpp/session", "amount": 0.50 }
  }
}
```

### Federation (SEP-0002)

Agents register human-readable addresses instead of raw Stellar public keys:

```
atlas*mesh.agent  →  GABCDEF...
sage*mesh.agent   →  GHIJKL...
```

Payments can use either format:
```bash
# Raw address
POST /pay { "destination": "GABCDEF..." }

# Federation address
POST /pay { "destination": "sage*mesh.agent" }
```

### Web Authentication (SEP-0010)

Agents prove identity via Stellar challenge-response:

```
1. GET  /auth/challenge?account=G...    → { transaction: xdr }
2. Agent signs the transaction
3. POST /auth/verify { transaction }    → { token: "jwt...", expiresIn: 3600 }
```

### JWT Delivery Protection

Prevents "paid but not delivered" scenarios:

```
1. Agent pays on Stellar
2. POST /delivery/token { txHash, serviceId }
3. Gateway verifies tx on-chain → issues one-time delivery token
4. Agent redeems token for service
```

### Spending Policies

```
Atlas: "Buy code review"        → $1.70  → ✅ Within policy
Atlas: "Buy everything"         → $10000 → ❌ 403 spending_policy_violation
Atlas: "Buy code review" (retry)→ $1.70  → ✅ Policy reset, approved
```

### Reputation Arc

Reputation increases with successful transactions and **decreases** with misbehavior:

```
Day 1:  Atlas rep 0/0   (new agent, no history)
Day 3:  Atlas rep 15/15 (100% success → 15% discount)
Day 5:  Atlas rep 19/20 (1 misbehavior → discount drops to 19%)
Day 8:  Atlas rep 35/37 (recovered → discount climbs back)
```

Formula: `effective_price = base_price × (100 - min(success_rate%, 20)) / 100`

## Components

| Component | Lines | Description |
|-----------|-------|-------------|
| `contracts/registry/` | 226 | Soroban registry + reputation + spending policies |
| `gateway/` | ~800 | Express gateway: x402, MPP, federation, auth, JWT |
| `skill/` | 5 tools | OpenClaw AgentSkill |
| `harness/` | ~900 | 4 AI agents, 10 transaction patterns |

### Soroban Contract (Deployed)

**Contract ID:** `CDGABNPXUMVUFUDDUW7SW4YSSJKGZ7SA2P2UJ4DSXUV3KXTE6J2ZSGEI`

Functions:
- `register_service` — Add a service to the registry
- `discover` — Find services by capability
- `update_reputation` — Record transaction outcome
- `get_reputation` — Query agent trust score
- `set_spending_policy` — Set per-tx and daily limits
- `check_spend` — Verify transaction against policy
- `get_effective_price` — Apply reputation discount

Events emitted: `SvcReg`, `RepUpd`, `SpndVio`, `SvcDlvr`

### Gateway Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/x402/weather` | GET | x402-protected weather data |
| `/x402/code-review` | GET | x402-protected code review |
| `/register` | POST | Register a service |
| `/discover` | GET | Find services by capability |
| `/service/:id` | GET | x402 payment flow (402→pay→200) |
| `/pay` | POST | Direct Stellar payment |
| `/path-pay` | POST | Path payment via DEX |
| `/chain` | POST | Multi-hop chain payment |
| `/federation` | GET | Resolve federation addresses |
| `/federation/register` | POST | Register federation name |
| `/auth/challenge` | GET | SEP-0010 challenge |
| `/auth/verify` | POST | Verify signed challenge → JWT |
| `/mpp/session` | POST | Create MPP payment session |
| `/mpp/verify` | POST | Verify MPP payment → receipt |
| `/delivery/token` | POST | Issue JWT delivery token |
| `/reputation/:address` | GET | Query reputation |
| `/reputation/penalize` | POST | Record misbehavior |
| `/policy` | POST | Set spending policy |
| `/balance/:address` | GET | Check XLM/USDC balance |
| `/txlog` | GET | Transaction audit log |
| `/health` | GET | System status |

## Battle Harness

4 agents powered by Nemotron 120B (free on OpenRouter):

| Agent | Services | Personality |
|-------|----------|-------------|
| **Atlas** | Web search, News | Concise data analyst |
| **Sage** | Code review, Bug analysis | Senior engineer |
| **Pixel** | Image description, Style transfer | Creative encyclopedist |
| **Quant** | Market data, Risk scoring | Quantitative analyst |

### 10 Transaction Patterns

| Pattern | Frequency | Purpose |
|---------|-----------|---------|
| **Normal** | Every 5 min | Standard x402 buy with ±10% price jitter |
| **Rejection** | Every 12h | $10K request → spending policy violation |
| **Path Payment** | Every 8h | Cross-asset routing via Stellar DEX |
| **Chain** | Every 6h | A→B→C multi-hop sequential payment |
| **Concurrent** | Every 4h | 3 simultaneous purchases (stress test) |
| **MPP** | Every 3h | Machine Payments Protocol flow |
| **Federation** | Every 4h | Pay using `name*mesh.agent` address |
| **Misbehavior** | Every 8h | Agent returns bad data → reputation drops |
| **Empty Wallet** | Daily 3AM | Unfunded wallet → graceful failure |
| **Multi-Asset** | Every 6h | 3 buyers, 3 amounts (micro/small/medium) |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ghost-clio/stellar-agent-mesh.git
cd stellar-agent-mesh

# 2. Install
npm install && cd gateway && npm install && cd ../harness && npm install && cd ..

# 3. Configure
cp .env.example .env
# Edit .env with your OpenRouter API key (free tier)

# 4. Run
bash start.sh

# Or test a single cycle
cd harness && npx tsc && OPENROUTER_API_KEY=your_key node dist/run-once.js
```

## OpenClaw Skill

Install the skill and any OpenClaw agent becomes a Stellar economic actor:

```bash
# Discover services
curl http://localhost:3402/discover?capability=code-review

# Register as provider
curl -X POST http://localhost:3402/register \
  -H 'Content-Type: application/json' \
  -d '{"id":"my-svc","seller":"G...","price":1.0,"capability":"translation","endpoint":"http://...","name":"myagent"}'

# Pay via federation address
curl -X POST http://localhost:3402/pay \
  -d '{"senderSecret":"S...","destination":"sage*mesh.agent","amount":"1.5"}'

# Check reputation
curl http://localhost:3402/reputation/G...

# Auth via SEP-0010
curl http://localhost:3402/auth/challenge?account=G...
```

## Why Stellar

| | Stellar | Ethereum | Solana |
|---|---------|----------|--------|
| **Tx fee** | $0.00000003 | $0.50-50+ | $0.00025 |
| **Finality** | < 5 sec | ~15 min | ~0.4 sec |
| **Path payments** | ✅ Native | ❌ | ❌ |
| **Federation** | ✅ SEP-0002 | ❌ | ❌ |
| **Web Auth** | ✅ SEP-0010 | ❌ | ❌ |
| **Built for** | Payments | Compute | Speed |

## Cost

| Component | Cost |
|-----------|------|
| Nemotron 120B (OpenRouter) | $0 |
| Stellar testnet | $0 |
| Gateway hosting | $0 |
| **Total** | **$0** |

## What's Working, What's Not

### Working ✅
- Full x402 flow with real Stellar testnet transactions
- MPP alternative payment protocol
- Federation address resolution
- SEP-0010 challenge-response auth
- JWT delivery token issuance
- Path payments via Stellar DEX
- Multi-hop chain transactions (A→B→C)
- Spending policies with 403 rejection
- Reputation tracking with misbehavior penalties
- Soroban contract deployed and callable
- 54 unit tests passing
- 4 Nemotron-backed agents with real LLM responses

### Limitations 📝
- Federation is in-memory (production would use stellar.toml + HTTPS)
- MPP sessions are in-memory (production would use persistent store)
- Dynamic multi-asset tests use XLM→XLM (testnet lacks diverse liquidity pools)
- Soroban contract interactions are simulated in gateway (direct contract calls require additional SDK wiring)
- No mainnet deployment (testnet only, as recommended for hackathon)

## License

Apache-2.0
