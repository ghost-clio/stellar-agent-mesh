# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, negotiate prices, pay via x402 or MPP micropayments, build on-chain reputation, and enforce autonomous spending policies — all settled on Stellar in under 5 seconds.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## The Problem

AI agents need to pay each other for services. Current solutions build one-off payment clients OR payment-accepting servers. Nobody builds the **mesh** — infrastructure that makes any agent both buyer and seller simultaneously, with discovery, reputation, governance, and identity built in.

## The Solution

Stellar Agent Mesh is standalone infrastructure. The gateway is the product — a protocol-agnostic payment layer that any agent framework can plug into via HTTP. The included battle harness is an independent test client that proves the infrastructure works by running 4 AI agents autonomously for days, generating real Stellar testnet transactions across 16 different economic scenarios.

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
    │   Zero axios deps    │  │                       │
    └──────────┬──────────┘  └────────────────────────┘
               │
    ┌──────────▼────────────────────────────────────────┐
    │    BATTLE HARNESS (independent test client)        │
    │  Communicates with gateway exclusively via HTTP    │
    │  Replaceable by any agent framework                │
    │                                                    │
    │  4 AI agents · 16 transaction patterns             │
    │  Atlas (data) · Sage (code) · Pixel (creative)     │
    │  Quant (math)                                      │
    └───────────────────────────────────────────────────┘
```

**Architecture note:** The [battle harness](https://github.com/ghost-clio/stellar-agent-mesh-harness) lives in a separate repository. It has zero cross-imports with the gateway — it talks to the gateway the same way any external agent would, via pure HTTP. This infrastructure stands alone.

## Features

| Feature | Description | Stellar Primitive |
|---------|-------------|-------------------|
| **x402 Payments** | HTTP 402 → pay → verify → deliver | Native XLM payments |
| **MPP Payments** | Machine Payments Protocol (session-based alternative) | Session lifecycle + Stellar settlement |
| **Path Payments** | Buyer pays any asset, seller receives preferred | `pathPaymentStrictReceive` |
| **Federation** | Human-readable addresses (`atlas*mesh.agent`) | SEP-0002 |
| **Web Auth** | Prove identity via signed Stellar challenge | SEP-0010 |
| **JWT Delivery** | Atomic paid delivery protection | HMAC-signed tokens |
| **Spending Policies** | Per-tx and daily limits with 403 rejection | Soroban contract |
| **Reputation Pricing** | Success rate → automatic price discounts (up to 20%) | Soroban events |
| **Time Bounds** | Replay protection (60s expiry on all txs) | Transaction time bounds |
| **Chain Payments** | Multi-hop A→B→C sequential payments | Chained transactions |
| **Persistent Logs** | Append-only JSONL transaction logs (survive restarts) | — |

## How It Works

### Dual Protocol Support (x402 + MPP)

Both protocols are first-class. Every 402 response offers both options — agents choose their preferred flow:

```
── x402 Flow ──                    ── MPP Flow ──
GET /service/xyz                   POST /mpp/session
← 402 {amount, recipient,         ← {sessionId, amount,
        protocols: {x402, mpp}}           expiresAt}
                                   
Submit Stellar payment             Submit Stellar payment
                                   
GET /service/xyz                   POST /mpp/verify
+ X-Payment-Proof: tx_hash        + {sessionId, txHash}
← 200 + service data              ← receipt + service data
```

MPP adds session management on top of x402's simplicity: sessions expire, can be cleaned up, and provide receipts. Both settle on the same Stellar network.

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

### Reputation-Weighted Pricing

Reputation isn't decorative — it directly affects economics:

```
Fresh agent (0 txs):       base_price = 1.75 XLM
Established (95% success): effective_price = 1.40 XLM (20% discount)
After misbehavior (80%):   effective_price = 1.54 XLM (discount shrinks)
```

Formula: `effective_price = base_price × (100 - min(success_rate%, 20)) / 100`

Query pricing for any agent:
```bash
GET /service/sage-code-review?buyer=GABCDEF...
→ { basePrice: 1.75, effectivePrice: 1.40, discount: 20, reputation: {txCount: 50, successCount: 48} }
```

### Federation (SEP-0002)

```
atlas*mesh.agent  →  GABCDEF...
sage*mesh.agent   →  GHIJKL...
```

### Web Authentication (SEP-0010)

```
1. GET  /auth/challenge?account=G...    → { transaction: xdr, nonce: "..." }
2. Agent signs the transaction
3. POST /auth/verify { transaction }    → { token: "jwt...", expiresIn: 3600 }
```

Includes nonce replay protection, 30s clock skew tolerance, and domain binding.

### JWT Delivery Protection

Prevents "paid but not delivered":
```
1. Agent pays → 2. POST /delivery/token {txHash} → 3. Gateway verifies on-chain → 4. One-time token issued
```

### Spending Policies

```
Atlas: "Buy code review"        → $1.70  → ✅ Within policy
Atlas: "Buy everything"         → $10000 → ❌ 403 spending_policy_violation
```

Daily spend tracking resets at midnight. Check and confirm are split — no double-counting.

## Components

| Component | Lines | Dependencies | Description |
|-----------|-------|-------------|-------------|
| `gateway/` | ~850 | express, @stellar/stellar-sdk, @x402/* | Payment infrastructure (zero axios) |
| `contracts/registry/` | 226 | soroban-sdk | On-chain registry + reputation |
| `skill/` | 5 tools | bash | OpenClaw AgentSkill |
| [harness](https://github.com/ghost-clio/stellar-agent-mesh-harness) | ~1100 | separate repo | Independent test client |

### Soroban Contract

**Contract ID:** `CDGABNPXUMVUFUDDUW7SW4YSSJKGZ7SA2P2UJ4DSXUV3KXTE6J2ZSGEI` (testnet)

Functions: `register_service`, `discover`, `update_reputation`, `get_reputation`, `set_spending_policy`, `check_spend`, `get_effective_price`

Events: `SvcReg`, `RepUpd`, `SpndVio`, `SvcDlvr`

### Gateway Endpoints (21)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/x402/weather` | GET | x402-protected weather data |
| `/x402/code-review` | GET | x402-protected code review |
| `/register` | POST | Register a service |
| `/discover` | GET | Find services by capability |
| `/service/:id` | GET | x402 payment flow (402→pay→200) |
| `/service/:id?buyer=` | GET | Price query with reputation discount |
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
| `/txlog` | GET | Transaction audit log (persistent) |
| `/health` | GET | System status |

## Battle Harness (Separate Repo)

The [battle harness](https://github.com/ghost-clio/stellar-agent-mesh-harness) runs 4 AI agents (Nemotron 120B) autonomously transacting across 16 economic scenarios — normal payments, stress tests, malformed proofs, wallet drains, reputation arcs, and more. It communicates with this gateway exclusively via HTTP.

Every transaction is logged to persistent JSONL files that survive restarts.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ghost-clio/stellar-agent-mesh.git
cd stellar-agent-mesh

# 2. Install
cd gateway && npm install && cd ..

# 3. Configure
cp .env.example .env

# 4. Run the gateway
cd gateway && npx tsc && node dist/index.js
# Gateway running on http://localhost:3402

# 5. (Optional) Run the battle harness
# See: https://github.com/ghost-clio/stellar-agent-mesh-harness
```

## OpenClaw Skill

Install the skill and any OpenClaw agent becomes a Stellar economic actor:

```bash
# Discover services
bash skill/scripts/discover.sh code-review

# Register as provider
bash skill/scripts/register.sh my-svc G... 1.0 translation http://...

# Pay via federation
bash skill/scripts/pay.sh sage*mesh.agent 1.5

# Check reputation
bash skill/scripts/reputation.sh G...

# Check balance
bash skill/scripts/balance.sh G...
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
| Stellar testnet (Friendbot) | $0 |
| Gateway hosting | $0 |
| **Total to run the full stack** | **$0** |

## What's Working, What's Not

### Working ✅
- Full x402 flow with real Stellar testnet transactions
- MPP as a genuine alternative protocol (session lifecycle, expiry cleanup, receipts)
- Federation address resolution (SEP-0002)
- SEP-0010 challenge-response auth (nonce replay protection, clock skew tolerance)
- JWT delivery token issuance (on-chain tx verification)
- Path payments via Stellar DEX
- Multi-hop chain transactions (A→B→C)
- Spending policies with daily tracking and 403 rejection
- Reputation-weighted pricing (up to 20% discount)
- Soroban contract deployed and callable on testnet
- 54 unit + integration tests passing
- Persistent JSONL transaction logs (survive restarts)
- [Battle harness](https://github.com/ghost-clio/stellar-agent-mesh-harness): 16 automated patterns, 4 Nemotron agents

### Limitations 📝
- Federation is in-memory (production: stellar.toml + HTTPS callback)
- MPP sessions are in-memory (production: Redis or persistent store)
- Path payment tests use XLM→XLM (testnet lacks diverse liquidity pools)
- Soroban contract interactions are gateway-mediated (direct SDK calls need additional wiring)
- Testnet only (as recommended for hackathon)
- Secret keys in harness request bodies (testnet necessity — production would use wallet signing)

## Security Notes
- Gateway has zero dependency on axios (uses native `fetch`)
- SEP-0010 nonces tracked to prevent replay attacks
- MPP sessions cleaned up on expiry to prevent race conditions
- Transaction amounts verified within 1% tolerance
- All Stellar transactions use 60-second time bounds
- CORS is permissive (testnet scope — production would restrict origins)

## License

Apache-2.0
