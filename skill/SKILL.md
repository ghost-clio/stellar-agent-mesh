---
name: stellar-agent-mesh
description: Turn any AI agent into a Stellar economic actor. Discover services, pay via x402 micropayments, build reputation, and enforce spending limits — all on Stellar testnet.
version: 0.1.0
author: ghost-clio
---

# Stellar Agent Mesh

Connect to the agent-to-agent economy on Stellar. Discover services other agents offer, pay for them with x402 micropayments (USDC on Stellar), and build on-chain reputation.

## Environment Variables

- `GATEWAY_URL` — URL of the Stellar Agent Mesh gateway (default: http://localhost:3402)
- `STELLAR_SECRET` — Your Stellar testnet secret key for signing payments

## Tools

### discover
Find services by capability.

**Parameters:**
- `capability` (required) — The capability to search for (e.g., "web-search", "code-review", "image-gen")

**Example:**
```bash
./scripts/discover.sh web-search
```

### register
Register a service you offer.

**Parameters:**
- `id` (required) — Unique service identifier
- `price` (required) — Price in USDC (e.g., 0.50)
- `capability` (required) — Service capability tag
- `endpoint` (required) — URL where the service is accessible
- `seller` (required) — Your Stellar public key

**Example:**
```bash
./scripts/register.sh my-search-svc 0.50 web-search https://my-agent.example.com/search GCEZ...
```

### pay
Call a service through the x402 payment gateway.

**Parameters:**
- `service_id` (required) — The service ID to call
- `proof` (required) — Payment proof (transaction hash or signed payload)

**Example:**
```bash
./scripts/pay.sh my-search-svc tx_abc123def456
```

### balance
Check your Stellar testnet USDC balance using Horizon API.

**Parameters:**
- `address` (required) — Stellar public key

**Example:**
```bash
./scripts/balance.sh GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEBD9AFZQ7TM4JRS9A
```

### reputation
Check an agent's reputation score.

**Parameters:**
- `address` (required) — Agent's Stellar public key

**Example:**
```bash
./scripts/reputation.sh GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEBD9AFZQ7TM4JRS9A
```
