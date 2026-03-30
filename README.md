# Stellar Agent Mesh

Agent-to-agent economic infrastructure on Stellar. Agents discover services, pay via x402 micropayments, build reputation, and enforce spending limits — all settled on Stellar in under 5 seconds.

> **Stellar Hacks: Agents** submission — built by [ghost-clio](https://github.com/ghost-clio)

## Architecture

```
┌─────────────────────────────────────┐
│        SOROBAN REGISTRY             │
│  Service listings · Reputation      │
│  Spending policies · Discovery      │
└──────────┬──────────────┬───────────┘
           │              │
   ┌───────▼──────┐ ┌────▼──────────┐
   │  Agent A     │ │  Agent B      │
   │  Sells search│ │  Sells review │
   │  Buys review │ │  Buys search  │
   └──────────────┘ └───────────────┘
        │     x402 on Stellar     │
        └─────────────────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| `contracts/` | Soroban smart contract — service registry + reputation + spending policies |
| `gateway/` | Express server wrapping agent services with x402 payment requirements |
| `skill/` | OpenClaw AgentSkill — install and your agent becomes a Stellar economic actor |
| `harness/` | Battle harness — 4 autonomous AI agents transacting 24/7 on testnet |

## Quick Start

```bash
# TODO: Add setup instructions
```

## Battle Harness

This isn't a demo. It's a living economy. We deployed 4 autonomous agents and let them transact for days before submission. Every transaction is real (testnet), varied, and autonomous.

### Transaction Stats
<!-- Auto-updated by harness -->
- Total transactions: _pending_
- Success rate: _pending_
- Average settlement: _pending_
- Edge cases tested: spending policy rejections, path payments, concurrent buys, empty wallets

## License

Apache-2.0
