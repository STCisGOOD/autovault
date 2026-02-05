# persistence-agent-identity

**Persistent, self-evolving identity for AI agents.** Store identity on Solana, evolve through behavior, transact with other agents.

## What It Does

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR AI AGENT                           │
│                   (Claude Code, Cursor, etc.)                   │
├─────────────────────────────────────────────────────────────────┤
│  Session Start                    Session End                   │
│       │                                │                        │
│       ▼                                ▼                        │
│  ┌─────────────┐                ┌─────────────┐                 │
│  │  Get        │                │  ActionLog  │                 │
│  │  Context    │◄───────────────│  (behavior) │                 │
│  │  Modifier   │    evolves     └──────┬──────┘                 │
│  └─────────────┘                       │                        │
│       │                                ▼                        │
│       ▼                         ┌─────────────┐                 │
│  System prompt              →   │   Weights   │   → Solana      │
│  adjustments                    │   evolve    │                 │
│                                 └─────────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Behavioral identity**: Weights (curiosity, precision, persistence, empathy) evolve based on what your agent *actually does*
- **On-chain persistence**: Identity state stored on Solana devnet via memos
- **Agent-to-agent payments**: x402 micropayments for agent services (using devnet tokens)

## Install

### CLI (Recommended — easiest path)

```bash
npm install -g persistence-agent-identity-cli
```

### Library (for custom integrations)

```bash
npm install persistence-agent-identity
```

## Quick Start — CLI

The fastest way to get persistent identity running:

```bash
# 1. Initialize identity (generates keypair, requests devnet SOL)
persistence-identity init --claude-code

# 2. Check your identity
persistence-identity status --verbose

# 3. Declare insights as you work
persistence-identity learn "Reading tests first reveals intent faster than source"

# 4. Evolve identity based on accumulated insights
persistence-identity evolve --commit

# 5. Update CLAUDE.md with behavioral guidance
persistence-identity inject
```

The `--claude-code` flag installs hooks into `~/.claude/settings.json` that automatically track sessions, tool calls, and insight markers. See the [CLI package](../agent-identity-cli/) for full documentation.

## Quick Start — Library API

For custom agents or deeper integration:

```typescript
import {
  createIdentityManager,
  createSolanaStorageBackend,
  publicKeyToDid,
} from 'persistence-agent-identity';
import { Connection, Keypair } from '@solana/web3.js';

// 1. Setup
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.generate();  // Or load existing
const did = publicKeyToDid(payer.publicKey, 'devnet');

// 2. Create storage backend (writes to Solana)
const storage = createSolanaStorageBackend({
  connection,
  payer,
  namespace: did,
});

// 3. Create identity manager
const manager = createIdentityManager(storage);
await manager.load();  // Loads existing or creates new

// 4. Session lifecycle
const context = await manager.onSessionStart('session-1');
// context.promptAdditions = ["You have high curiosity - explore beyond requirements..."]
// context.behavioralHints = { curiosity: 0.7, precision: 0.5, ... }

// ... agent does work, collects ActionLog ...

const result = await manager.onSessionEnd('session-1', actionLog);
// Weights evolved, saved to Solana
// result.summary = "curiosity: 0.5 → 0.7 ↑"
```

## Agent Integration

### For Claude Code / Cursor / Similar

The agent is responsible for:
1. **Calling lifecycle hooks** at session start/end
2. **Collecting ActionLog** from tool calls during the session
3. **Applying context modifiers** to its system prompt (optional)

```typescript
// Implement the AgentRuntime interface
import { AgentRuntime, ContextModifier } from 'persistence-agent-identity';

class MyAgentAdapter implements AgentRuntime {
  agentId = 'my-agent';

  // Optional: apply identity-derived prompts
  applyContextModifier(context: ContextModifier): boolean {
    // Add context.promptAdditions to your system prompt
    return true;
  }
}
```

### ActionLog Structure

```typescript
interface ActionLog {
  interactionId: string;
  startTime: number;
  endTime: number;
  toolCalls: ToolCall[];  // What tools were called
  decisions: Decision[];   // What choices were made
  failures: Failure[];     // What went wrong
  // ...
}

interface ToolCall {
  tool: string;       // 'Read', 'Write', 'Bash', etc.
  args: object;       // Tool arguments
  success: boolean;   // Did it succeed?
  durationMs: number; // How long did it take?
}
```

### How Behavior Maps to Weights

| Agent Behavior | Weight Affected |
|----------------|-----------------|
| Reading many files beyond requirements | **Curiosity** ↑ |
| Verifying changes, running tests | **Precision** ↑ |
| Retrying after failures | **Persistence** ↑ |
| Asking clarifying questions | **Empathy** ↑ |

## x402 Agent-to-Agent Payments

Agents can pay each other for services using devnet tokens:

```typescript
import { createPaymentGateway } from 'persistence-agent-identity';

// Agent A offers a service
const gateway = createPaymentGateway({
  network: 'devnet',
  enabled: true,
  payToAddress: agentAWallet.toBase58(),
});

// Check if payment required
if (gateway.requiresPayment('verification')) {
  const requirements = gateway.buildPaymentRequirements('verification');
  // { asset: 'USDC', price: '$0.001', network: 'solana:...' }
}
```

## Architecture

```
src/
├── core/           # AgentRuntime interface, IdentityManager
├── bootstrap/      # Keypair, Solana storage, private storage
├── behavioral/     # Weight evolution, PDEs, declarations
└── economic/       # x402 payments, cost tracking
```

## DID Format

```
did:persistence:devnet:<base58-pubkey>
```

Example: `did:persistence:devnet:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`

## Tests

```bash
npm test                              # All tests (163 passing)
npm test -- --testPathPattern=e2e     # End-to-end devnet test
```

## Packages

| Package | Description |
|---------|-------------|
| [`persistence-agent-identity`](./README.md) | Core library — identity, storage, evolution |
| [`persistence-agent-identity-cli`](../agent-identity-cli/) | CLI & Claude Code hooks — the fastest path to identity |

## Further Reading

- [SETUP.md](./SETUP.md) - **Agent Integration Guide** (start here if you're an AI assistant)
- [WHITEPAPER.md](./WHITEPAPER.md) - Mathematical foundations
- [STATUS.md](./STATUS.md) - Implementation status

## License

MIT
