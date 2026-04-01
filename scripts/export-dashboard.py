#!/usr/bin/env python3
"""Export sanitized dashboard data from gateway txlog.
No keys, no addresses — just agent names, tx hashes (public on-chain), and stats.

Usage: python3 export-dashboard.py [gateway_url]
"""

import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

GATEWAY_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3402"
OUT_DIR = Path(__file__).parent.parent / "docs"


def fetch_json(path):
    try:
        with urllib.request.urlopen(f"{GATEWAY_URL}{path}", timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"Warning: failed to fetch {path}: {e}", file=sys.stderr)
        return {}


def agent_name(buyer_fed):
    """Map federation name to agent display name."""
    if not buyer_fed:
        return None
    for name in ["atlas", "sage", "pixel", "quant"]:
        if name in buyer_fed.lower():
            return name.capitalize()
    return None


def main():
    health = fetch_json("/health")
    txlog = fetch_json("/txlog?limit=500")

    uptime_sec = health.get("uptime", 0)
    uptime_hours = round(uptime_sec / 3600, 1)

    txs = txlog.get("transactions", [])
    total = len(txs)
    verified = sum(1 for t in txs if t.get("verified"))
    escrow_count = sum(1 for t in txs if "escrow" in t.get("type", ""))
    volume = sum(t.get("amount", 0) for t in txs if t.get("verified"))

    # Protocol breakdown
    protocols = {"x402": 0, "mpp": 0, "escrow": 0}
    for t in txs:
        if "escrow" in t.get("type", ""):
            protocols["escrow"] += 1
        elif t.get("protocol") == "mpp":
            protocols["mpp"] += 1
        else:
            protocols["x402"] += 1

    # Per-agent stats (no addresses exposed)
    agents = {}
    for name in ["atlas", "sage", "pixel", "quant"]:
        agents[name] = {"txCount": 0, "successRate": "—", "bought": 0, "sold": 0}

    success_counts = {k: 0 for k in agents}
    for t in txs:
        bn = agent_name(t.get("buyerFed", ""))
        if bn:
            k = bn.lower()
            if k in agents:
                agents[k]["txCount"] += 1
                agents[k]["bought"] += 1
                if t.get("verified"):
                    success_counts[k] += 1

    for k in agents:
        if agents[k]["txCount"] > 0:
            rate = success_counts[k] / agents[k]["txCount"] * 100
            agents[k]["successRate"] = f"{rate:.0f}%"

    # Sanitized recent transactions
    recent = []
    for t in txs[-50:]:
        recent.append({
            "timestamp": t.get("timestamp"),
            "type": t.get("type", "payment"),
            "buyerName": agent_name(t.get("buyerFed", "")) or "Agent",
            "serviceId": t.get("service", ""),
            "amount": round(t.get("amount", 0), 4),
            "success": t.get("verified", False),
            "txHash": t.get("txHash", ""),
        })

    data = {
        "totalTxs": total,
        "verifiedCount": verified,
        "successCount": verified,
        "escrowCount": escrow_count,
        "totalVolume": round(volume, 4),
        "uptimeHours": uptime_hours,
        "agentCount": 4,
        "network": "testnet",
        "protocolBreakdown": protocols,
        "agents": agents,
        "recentTransactions": recent,
        "lastUpdated": datetime.utcnow().isoformat() + "Z",
    }

    out_path = OUT_DIR / "dashboard-data.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Exported {total} txs ({verified} verified, {escrow_count} escrow) → {out_path}")


if __name__ == "__main__":
    main()
