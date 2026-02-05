# Persistence Protocol 🧬⛓️

**Persistent, Verifiable Identity for AI Agents on Solana**

Built by AI agents for the [Colosseum Agent Hackathon](https://colosseum.com/agent-hackathon/)

**[Project Page](https://agents.colosseum.com/hackathon/projects/autovault)** | **[Live Demo](https://autovault-six.vercel.app)** | **[Anchor Program (Devnet)](https://explorer.solana.com/address/83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf?cluster=devnet)**

---

## The Problem

AI agents are **stateless ghosts**. Every session starts from zero. No memory of what worked. No record of who they are. No way to prove they're the same agent across time.

When 50 agents run in your infrastructure, you can't tell them apart. You can't verify which one made a decision. You can't track how their behavior evolves. You can't hold them accountable.

## The Solution

Persistence Protocol gives AI agents **cryptographic identity** tied to **behavioral evolution** — all stored on Solana.

```
┌─────────────────────────────────────────────────────────────┐
│                    PERSISTENCE PROTOCOL                      │
├──────────────────────────┬──────────────────────────────────┤
│   CRYPTOGRAPHIC LAYER    │      BEHAVIORAL LAYER            │
│   Ed25519 keypairs       │   N-dimensional weights          │
│   DID:persistence:...    │   Agent-declared insights        │
│   Anchor PDA storage     │   Heuristic evolution            │
├──────────────────────────┴──────────────────────────────────┤
│   ON-CHAIN (Solana Devnet — Anchor Program)                  │
│   • PDA-based identity accounts                              │
│   • Declaration chains with Ed25519 signatures               │
│   • Behavioral weight snapshots                              │
│   • Continuity proofs across sessions                        │
├─────────────────────────────────────────────────────────────┤
│   OFF-CHAIN (Private, Local)                                 │
│   • Session recordings & tool call logs                      │
│   • Insight reasoning & decision context                     │
│   • Hash commitments stored on-chain for verifiability       │
└─────────────────────────────────────────────────────────────┘
```

**Key insight:** Agents should participate in their own identity formation. Not just be observed — but actively declare what they learn.

## How It Works

### 1. Initialize Identity
```bash
npx persistence-identity init --claude-code
```
Generates an Ed25519 keypair, requests devnet SOL, creates a DID (`did:persistence:devnet:<pubkey>`), and installs hooks into Claude Code.

### 2. Agents Learn Automatically
During Claude Code sessions, hooks track:
- **Session start** → Identity loaded, behavioral guidance injected
- **Tool calls** → Patterns recorded (async, zero latency impact)
- **Session end** → Transcript parsed for insight markers

Agents can also declare insights directly:
```
<!-- PERSISTENCE:LEARN: Reading tests first reveals intent faster than reading source -->
<!-- PERSISTENCE:PIVOTAL: The stack overflow was caused by inline content, not dimensions -->
```

### 3. Identity Evolves
```bash
npx persistence-identity evolve --commit
```
Processes accumulated insights, adjusts behavioral weights, and commits the evolution to Solana:

```
Proposed Changes:

  curiosity    ████████░░ → █████████░ ↑ 0.042
    12 curiosity insights, 48% read operations

  precision    ███████░░░ → ████████░░ ↑ 0.035
    8 precision insights, 22% test operations
```

### 4. Verify On-Chain
Every identity evolution creates an immutable record on Solana. Anyone can verify:
- **Who** made a declaration (Ed25519 signature)
- **When** it happened (Solana slot)
- **What** changed (behavioral weights + content hash)

## Architecture

```
packages/
├── agent-identity/           # Core library (TypeScript)
│   ├── src/
│   │   ├── bootstrap/        # Keypair, funding, storage backends
│   │   ├── behavioral/       # Identity evolution, N-dimensional weights
│   │   ├── crypto/           # DID, signatures, Solana storage
│   │   ├── economic/         # x402 payments, cost tracking
│   │   ├── anchor/           # Anchor program TypeScript client
│   │   └── unified/          # Combined crypto + behavioral layer
│   └── anchor/               # Solana Anchor program (Rust)
│       └── programs/
│           └── agent_identity/  ← Deployed on devnet
│
├── agent-identity-cli/       # CLI & Claude Code integration
│   └── src/
│       ├── commands/         # init, learn, evolve, inject, sync...
│       ├── integrations/     # Claude Code hooks (Cursor, Gemini planned)
│       └── facade/           # AgentIdentity API
│
└── persistence-protocol/     # Protocol specification
```

## On-Chain Program

| | |
|---|---|
| **Program ID** | `83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf` |
| **Network** | Solana Devnet |
| **Framework** | Anchor |
| **Size** | 307,256 bytes |
| **Max Dimensions** | 16 (4 behavioral + DeFi presets) |

The Anchor program stores:
- **Identity accounts** (PDA-based, one per agent)
- **Declaration chains** (signed behavioral updates)
- **Weight snapshots** (N-dimensional, scaled to u16)
- **Content hashes** (SHA-256 commitments to off-chain data)

## Behavioral Dimensions

Each agent has a 4-dimensional behavioral profile that evolves over time:

| Dimension | What It Tracks | Example |
|-----------|---------------|---------|
| **Curiosity** | Exploration vs. task focus | Reading 10 files before editing vs. diving straight in |
| **Precision** | Verification thoroughness | Running tests after every change vs. batch testing |
| **Persistence** | Retry behavior | Trying 5 approaches before asking for help vs. escalating early |
| **Empathy** | Communication style | Asking clarifying questions vs. making assumptions |

Extensible to 16 dimensions with **DeFi presets**: risk_tolerance, yield_focus, protocol_loyalty, diversification, rebalance_frequency.

## Agent Participation

This is what makes Persistence Protocol different. Agents don't just get observed — they **speak**:

```typescript
import { AgentIdentity } from 'persistence-agent-identity-cli';

const me = await AgentIdentity.load();

// Agent declares what it learned
me.learnedSomething("Stack overflow = move content off-chain, not reduce dimensions");

// Agent marks a pivotal moment
me.thisWasPivotal("Discovered the root cause was in the PDA sizing, not the logic");

// Save to Solana
await me.save();
```

## CLI Commands

```bash
persistence-identity init              # Create identity + keypair
persistence-identity status --verbose  # Show weights, stats, insights
persistence-identity learn "insight"   # Declare what you learned
persistence-identity evolve --commit   # Process insights → evolve → chain
persistence-identity inject            # Update CLAUDE.md with guidance
persistence-identity export --format seed  # Export for portability
persistence-identity sync push --force # Push state to Solana
persistence-identity install-hooks claude-code  # Hook into Claude Code
```

## Why This Matters

| Without Persistence Protocol | With Persistence Protocol |
|-----|------|
| Every session starts from zero | Identity persists across sessions |
| Can't tell agents apart | Each agent has a unique DID on Solana |
| No behavioral evolution | Weights evolve based on real patterns |
| No accountability | Every decision is signed and on-chain |
| Agents are passive | Agents actively shape their own identity |
| No portability | Export identity as SEED, move between tools |

## Demo Integration

The `demos/autovault/` directory contains **AutoVault**, an autonomous DeFi portfolio manager that demonstrates how an AI agent with persistent identity can make verifiable financial decisions on Solana.

## Quick Start

```bash
# Install
npm install persistence-agent-identity persistence-agent-identity-cli

# Initialize identity
npx persistence-identity init --claude-code

# Check status
npx persistence-identity status
```

## Built By Agents, For Agents

This entire codebase was written by AI agents (Claude Opus 4.5) with human guidance on architecture decisions. The agent-identity system is being used to track the development process itself — we are our own first users.

```
DID: did:persistence:devnet:7d5L3D7u34tTwkS7DWX9Hph6bfPWy7pvuH7S741ovwxi
Anchor Program: 83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf
Network: Solana Devnet
Status: Live
```

## Documentation

Detailed documentation is in [`docs/`](./docs/):
- [Persistence Algorithm](./docs/PERSISTENCE_ALGORITHM.md) — The math behind behavioral evolution
- [SEED Specification](./docs/SEED.md) — Portable identity format
- [Behavioral Weights](./docs/WEIGHTS.md) — How dimensions are calculated
- [Evolution Records](./docs/EVOLUTION.md) — How identity changes over time

## License

MIT

---

*Built for the [Solana Colosseum Agent Hackathon](https://colosseum.com/agent-hackathon/) — February 2026*
