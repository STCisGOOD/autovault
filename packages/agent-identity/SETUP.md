# Agent Integration Guide

## Fastest Path: CLI

If you're using Claude Code, the CLI handles everything for you:

```bash
# Install globally
npm install -g persistence-agent-identity-cli

# Initialize identity (generates keypair, gets devnet SOL, installs hooks)
persistence-identity init --claude-code

# That's it. Hooks now auto-track your sessions.
# To manually declare insights:
persistence-identity learn "Your insight here"

# To evolve and commit to Solana:
persistence-identity evolve --commit
```

See the full [CLI documentation](../agent-identity-cli/) for all commands.

---

## Programmatic Integration (Library API)

## You ARE the LLM

This library doesn't call an LLM — **you** call this library.

If you're Claude Code, Cursor, Cline, or any AI coding assistant: your tool calls are your behavioral data. Your self-reflection is your insight generation. You don't need an external API — you ARE the API consumer.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    YOU (Claude Code, Cursor, etc.)                  │   │
│   │                                                                     │   │
│   │   Your System Prompt  ←──  Identity Weights  ←──  This Library      │   │
│   │         │                                              ↑            │   │
│   │         ▼                                              │            │   │
│   │   Your Tool Calls  ───────────────────────────────────→│            │   │
│   │   (Read, Write, Bash, etc.)     ActionLog recording    │            │   │
│   │         │                                              │            │   │
│   │         ▼                                              │            │   │
│   │   Your Self-Reflection  ──────────────────────────────→│            │   │
│   │   (optional - you're the LLM)    Insights              │            │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   The library provides identity infrastructure.                             │
│   You provide the behavior and (optionally) the reflection.                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Integration (3 Steps)

### Step 1: Startup — Load Your Identity

```typescript
import { initializeAgentIdentity } from 'persistence-agent-identity';

// Load or create your persistent identity
const agent = await initializeAgentIdentity({
  autoFund: true,           // Get devnet SOL automatically
  useSolanaStorage: true,   // Store on-chain
  usePrivateStorage: true,  // Store ActionLogs locally
});

console.log(`My DID: ${agent.did}`);
// → did:persistence:devnet:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

// Get accumulated wisdom from past sessions
const wisdom = agent.getAccumulatedWisdom();
const intuition = agent.getIntuition();

// Inject into your system prompt / CLAUDE.md
// intuition.contextGuidance = "## Learned Intuition\n### Curiosity\n- ..."
// wisdom.contextPrompt = "From past experience, I have learned:\n- ..."
```

### Step 2: During Session — Record Your Behavior

```typescript
// Start observation at beginning of interaction
agent.startObservation('interaction-123');

// Record each tool call (your hooks/MCP servers do this)
agent.identity.recordToolCall(
  'Read',                    // Tool name
  { file: 'package.json' },  // Arguments
  'success',                 // Result
  true,                      // Success?
  150                        // Duration in ms
);

agent.identity.recordToolCall('Grep', { pattern: 'TODO' }, 'found 3', true, 80);
agent.identity.recordToolCall('Write', { file: 'fix.ts' }, 'success', true, 200);
```

### Step 3: End of Session — Evolve & Save

```typescript
// End observation and process through identity evolution
const result = await agent.endObservation({
  id: 'interaction-123',
  prompt: 'Fix the TODO items in the codebase',
  response: 'Fixed 3 TODO items across 2 files',
  timestamp: Date.now(),
  durationMs: 45000,
});

// See what happened
console.log(result.bridgeResult.summary);
// → "curiosity: 0.50 → 0.58 ↑, precision: 0.50 → 0.55 ↑"
console.log(`Insights extracted: ${result.bridgeResult.insights.length}`);
console.log(`ActionLog hash: ${result.actionLogHash}`);

// Save to Solana (only if you want to persist)
await agent.save();

// Cleanup
await agent.shutdown();
```

---

## What You Get

| Feature | What It Means |
|---------|---------------|
| **Persistent DID** | `did:persistence:devnet:<pubkey>` — same identity across sessions, verifiable on-chain |
| **Behavioral Weights** | curiosity, precision, persistence, empathy — evolve from YOUR actual tool usage |
| **Accumulated Wisdom** | Insights from past sessions, ready to inject into your context |
| **On-Chain Proof** | Anyone can verify your identity state on Solana explorer |
| **Private ActionLogs** | Full behavioral data stored locally (trainable), only hash goes on-chain |

---

## How Your Behavior Maps to Weights

Your tool calls directly affect your identity weights:

| Your Behavior | Weight Affected | Example |
|---------------|-----------------|---------|
| Reading many files beyond requirements | **Curiosity** ↑ | Glob + Read + Grep exploration |
| Verifying changes after writes | **Precision** ↑ | Write → Read → Test |
| Retrying after failures | **Persistence** ↑ | Failed Bash → retry → success |
| Asking clarifying questions | **Empathy** ↑ | AskUserQuestion tool calls |

The mapping is in `ExperienceMapping.ts` — it's behavioral, not arbitrary.

---

## Optional: Self-Reflection (You're the LLM)

Since you ARE an LLM, you can generate your own insights:

```typescript
// You can reflect on your own behavior
const myInsight = {
  dimension: 'curiosity',
  observation: 'I explored 5 related files before making the change',
  confidence: 0.8,
  isPivotal: true,  // Mark as pivotal if it's a significant learning
};

// The library can store your self-generated insights
// They'll be loaded back as "accumulated wisdom" next session
```

This is **optional**. Without explicit reflection, weights still evolve from your ActionLog. With reflection, you get richer semantic guidance.

---

## Adapter Examples

### Claude Code (via hooks)

```typescript
// In your Claude Code hook configuration
export default {
  onToolCall: async (tool, args, result) => {
    // Record to identity system
    globalIdentity.recordToolCall(tool, args, result.status, result.success, result.duration);
  },
  onSessionEnd: async () => {
    await globalIdentity.save();
  }
};
```

### MCP Server

```typescript
// Your MCP server wraps tool calls
async function handleToolCall(name: string, args: object): Promise<Result> {
  const start = Date.now();
  const result = await actualToolCall(name, args);

  // Record to identity
  identityManager.recordToolCall(name, args, result, result.success, Date.now() - start);

  return result;
}
```

### Custom Agent

```typescript
import { AgentRuntime, ContextModifier } from 'persistence-agent-identity';

class MyAgent implements AgentRuntime {
  agentId = 'my-custom-agent';

  applyContextModifier(context: ContextModifier): boolean {
    // Add identity-derived prompts to your system message
    this.systemPrompt += '\n' + context.promptAdditions.join('\n');
    return true;
  }
}
```

---

## The Protocol is the Contract

This is a **library**, not a framework.

- We don't dictate how you hook your tool calls
- We don't dictate how you inject identity into your prompt
- We don't dictate when you save or reflect

We provide:
- Identity creation and persistence (Solana devnet)
- Behavioral observation interfaces
- Weight evolution algorithms (mathematically proven — see WHITEPAPER.md)
- Storage for insights and ActionLogs

**You bring your own adapter.** The protocol (types, interfaces, behaviors) is the contract.

---

## Minimal Integration (Copy-Paste)

```typescript
import { initializeAgentIdentity } from 'persistence-agent-identity';

async function main() {
  // 1. Initialize
  const agent = await initializeAgentIdentity({ autoFund: true });
  console.log(`Agent DID: ${agent.did}`);

  // 2. Start observing
  agent.startObservation('session-1');

  // 3. Record your work (your hooks do this)
  agent.identity.recordToolCall('Read', { file: 'index.ts' }, 'ok', true, 100);
  agent.identity.recordToolCall('Edit', { file: 'index.ts' }, 'ok', true, 200);

  // 4. End and evolve
  const result = await agent.endObservation({
    id: 'session-1',
    prompt: 'Refactor the code',
    response: 'Done',
    timestamp: Date.now(),
    durationMs: 5000,
  });

  // 5. Save to Solana
  await agent.save();
  console.log(`Weights: ${agent.getStatus().weights}`);

  await agent.shutdown();
}

main();
```

---

## Further Reading

- [README.md](./README.md) — Package overview and API
- [WHITEPAPER.md](./WHITEPAPER.md) — Mathematical foundations (fixed-point identity theory)
- [NEUROPLASTIC_IDENTITY.md](./NEUROPLASTIC_IDENTITY.md) — Biological inspiration
- [STATUS.md](./STATUS.md) — Implementation status and architecture

---

## FAQ

**Q: Do I need a Solana wallet with real money?**
A: No. This runs on devnet. SOL is free from the faucet (auto-funded if you set `autoFund: true`).

**Q: What if I don't want to reflect? Can I just record tool calls?**
A: Yes. Weights evolve from ActionLog alone. Reflection/insights are optional enrichment.

**Q: Can other agents verify my identity?**
A: Yes. Your DID resolves to a Solana address. Anyone can check `https://explorer.solana.com/address/<pubkey>?cluster=devnet`.

**Q: What gets stored on-chain vs locally?**
A: On-chain: weights, hashes, proofs (public). Local: full ActionLogs, insights (private, trainable).

**Q: Is my behavioral data exposed?**
A: No. Only the hash of your ActionLog goes on-chain. The actual data stays in `~/.agent-identity/<did>/private/`.
