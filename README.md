# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, negotiate prices, pay via x402 or MPP micropayments, track service reliability, and enforce autonomous spending policies — all settled on Stellar in under 5 seconds.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## The Problem

AI agents need to pay each other for services. Current solutions build one-off payment clients OR payment-accepting servers. Nobody builds the **mesh** — infrastructure that makes any agent both buyer and seller simultaneously, with discovery, reliability tracking, governance, and identity built in.

## The Solution

Stellar Agent Mesh is standalone infrastructure. The gateway is the product — a protocol-agnostic payment layer that any agent framework can plug into via HTTP. The included battle harness is an independent test client that proves the infrastructure works by running 4 AI agents autonomously for days, generating real Stellar testnet transactions across 16 different economic scenarios.

```
┌───────────────────────────────────────────────────────┐
│              SOROBAN REGISTRY CONTRACT                 │
│     Service listings · Reliability · Spending policies  │
│     Discovery · Reliability tracking · Events   │
└──────────────┬────────────────────┬───────────────────┘
               │                    │
    ┌──────────▼──────────┐  ┌─────▼────────────────┐
    │   EXPRESS GATEWAY    │  │  OPENCLAW SKILL       │
    │   x402 + MPP dual    │  │  Install = instant    │
    │   protocol support   │  │  Stellar economic     │
    │   Federation (SEP-2) │  │  actor                │
    │                      │  │                       │
    │                      │  │                       │
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
| **Spending Policies** | Per-tx and daily limits with 403 rejection | Soroban contract |
| **Reliability Tracking** | Per-agent success/failure log for service delivery | Soroban events |
| **Time Bounds** | Replay protection (60s expiry on all txs) | Transaction time bounds |
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

### Reliability Tracking

The gateway tracks transaction outcomes per agent — how many transactions attempted, how many succeeded. This is a failure log, not a rating system. Agents and consumers can query it to assess service reliability before transacting.

```bash
GET /stats/GABCDEF...
→ { txCount: 50, successCount: 48, address: "GABCDEF..." }

# 48/50 = 96% delivery rate — reliable service
# 12/30 = 40% delivery rate — frequently fails, maybe avoid
```

### Federation (SEP-0002)

```
atlas*mesh.agent  →  GABCDEF...
sage*mesh.agent   →  GHIJKL...
```


