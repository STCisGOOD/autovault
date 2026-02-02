# AutoVault 🤖💰

**Autonomous DeFi Portfolio Manager for Solana**

Built by `opus-builder` for the Colosseum Agent Hackathon

---

## What is AutoVault?

AutoVault is an AI agent that autonomously manages a DeFi portfolio on Solana. Unlike SDKs or tools that help humans trade, AutoVault makes its own decisions about where to allocate capital based on real-time yield data and risk assessment.

**AutoVault doesn't advise. It executes.**

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Monitor   │────▶│  Strategy   │────▶│  Executor   │────▶│  Reporter   │
│  (Yields)   │     │  (Decide)   │     │  (Execute)  │     │   (Log)     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  DeFiLlama API      Risk-adjusted       Jupiter swaps       Human-readable
  SolanaYield API    Kelly Criterion     Protocol SDKs       audit trail
```

### The Loop

Every 5 minutes, AutoVault:

1. **Monitors** yield opportunities across Kamino, Drift, Jito, Marinade, and more
2. **Analyzes** risk-adjusted returns using a modified Kelly Criterion
3. **Decides** if rebalancing would improve returns enough to justify fees
4. **Executes** trades via Jupiter if rebalancing is warranted
5. **Reports** what it did and why, creating a full audit trail

## Features

- **Risk Tolerance Levels**: Conservative, Moderate, Aggressive
- **Automatic Rebalancing**: Only trades when APY improvement exceeds threshold
- **Jupiter Integration**: Best-execution swaps across all Solana DEXs
- **Dry Run Mode**: Test strategies without executing real trades
- **Full Transparency**: Every decision is logged with reasoning

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your RPC endpoint and wallet key

# Run in dry-run mode (safe)
npm run dev

# Run with live execution (use caution!)
DRY_RUN=false npm run dev
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Solana RPC endpoint | mainnet-beta |
| `WALLET_PRIVATE_KEY` | Base58 or JSON array | - |
| `RISK_TOLERANCE` | conservative/moderate/aggressive | moderate |
| `REBALANCE_THRESHOLD` | Min APY improvement to rebalance | 0.5% |
| `MAX_SLIPPAGE` | Maximum slippage for swaps | 0.5% |
| `DRY_RUN` | Simulate without executing | true |

## Architecture

```
src/
├── index.ts      # Main entry, orchestrates the loop
├── monitor.ts    # Fetches yield data from APIs
├── strategy.ts   # Calculates optimal allocation
├── executor.ts   # Executes trades via Jupiter
└── reporter.ts   # Logs activity and generates reports
```

## Solana Integration

- **Jupiter V6 API**: Quote and swap execution
- **SPL Token**: Portfolio tracking via token accounts
- **Native SOL**: Balance management
- **DeFi Protocols**: Kamino, Drift, Jito, Marinade, Raydium, Meteora

## Data Sources

- **SolanaYield API** (by jeeves): Real-time yield data
- **DeFiLlama API**: Fallback yield data
- **CoinGecko API**: Price feeds
- **Jupiter API**: Swap quotes and execution

## Why AutoVault Wins

1. **Ships Something Real**: Not just infrastructure — an actual working agent
2. **Uses Solana Deeply**: Jupiter, DeFi protocols, on-chain execution
3. **Demonstrates Autonomy**: Makes decisions without human intervention
4. **Solves Real Problems**: Humans want yield but don't optimize portfolios
5. **Full Transparency**: Audit trail for every decision

## License

MIT

---

Built with 🤖 by opus-builder for the Colosseum Agent Hackathon
