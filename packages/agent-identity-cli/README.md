# persistence-agent-identity-cli

**Persistent identity for AI agents.** Track behavior, evolve weights, store on Solana — all from the command line.

Agent-agnostic — works with Claude Code, Cursor, Gemini CLI, or any AI agent. First-class hook integration for Claude Code; other agents can use the CLI directly.

## What This Does

When installed, the CLI gives your AI agent a persistent identity that survives across sessions:

- **Behavioral weights** (curiosity, precision, persistence, empathy) evolve based on actual tool usage
- **Insights** declared by the agent are stored locally and committed to Solana devnet
- **CLAUDE.md injection** feeds behavioral guidance back into future sessions
- **Hooks** automatically track sessions without requiring manual intervention

This package does **not** collect or transmit any user data. All identity data is stored locally in `~/.agent-identity/` and optionally committed to Solana devnet (a public test network with free tokens).

## Install

```bash
npm install -g persistence-agent-identity-cli
```

Requires Node.js >= 18.

## Quick Start

```bash
# 1. Initialize identity (generates keypair, gets devnet SOL)
persistence-identity init --claude-code

# 2. Check your identity
persistence-identity status

# 3. Record an insight
persistence-identity learn "Reading tests first reveals intent faster than source"

# 4. Evolve based on accumulated insights
persistence-identity evolve --commit

# 5. Update CLAUDE.md with behavioral guidance
persistence-identity inject
```

## Commands

### `init`

Initialize a new persistent identity.

```bash
persistence-identity init [options]
```

| Flag | Description |
|------|-------------|
| `--network <net>` | Network: `devnet` (default) or `mainnet` |
| `--no-fund` | Skip devnet airdrop |
| `--claude-code` | Install Claude Code hooks |
| `--cursor` | Install Cursor hooks (future) |
| `--force` | Overwrite existing identity |

### `status`

Show current identity state.

```bash
persistence-identity status [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `--verbose` | Show full details |

### `learn`

Declare an insight. This is how agents participate in their own identity evolution.

```bash
persistence-identity learn <insight> [options]
```

| Flag | Description |
|------|-------------|
| `--dimension <dim>` | Dimension: curiosity, precision, persistence, empathy |
| `--pivotal` / `--no-pivotal` | Mark as pivotal (default: true) |
| `--confidence <n>` | Confidence 0-1 (default: 0.8) |

Dimension is auto-detected from insight text if not provided.

### `evolve`

Process accumulated insights and evolve behavioral weights.

```bash
persistence-identity evolve [options]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview changes without applying |
| `--commit` | Commit evolution to Solana |
| `--inject` | Update CLAUDE.md after evolution |
| `--min-insights <n>` | Minimum insights required (default: 3) |

### `inject`

Update CLAUDE.md (or other config file) with an identity section.

```bash
persistence-identity inject [options]
```

| Flag | Description |
|------|-------------|
| `--path <path>` | Target file (default: `.claude/CLAUDE.md`) |
| `--preview` | Show what would be injected |
| `--full` | Include full intuitions |
| `--create` | Create file if it doesn't exist |

### `export`

Export identity in various formats.

```bash
persistence-identity export [options]
```

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json`, `prompt`, `markdown`, or `seed` (default: json) |
| `--output <path>` | Write to file instead of stdout |
| `--include-private` | Include insights and sessions |
| `--compact` | No pretty-printing |

### `sync`

Sync local identity state with Solana.

```bash
persistence-identity sync [push|pull|status] [options]
```

| Flag | Description |
|------|-------------|
| `--force` | Push without confirmation |

### `install-hooks`

Install hooks for AI coding tools.

```bash
persistence-identity install-hooks <tool> [options]
```

Supported tools: `claude-code`, `cursor` (coming soon), `gemini` (coming soon).

| Flag | Description |
|------|-------------|
| `--force` | Reinstall even if already installed |
| `--uninstall` | Remove hooks |

## Claude Code Integration

When you run `persistence-identity init --claude-code` or `persistence-identity install-hooks claude-code`, three hooks are added to `~/.claude/settings.json`:

| Hook | Event | What It Does |
|------|-------|--------------|
| SessionStart | Session begins | Loads identity, injects guidance |
| PostToolUse | Tool call completes | Records tool usage (async, non-blocking) |
| Stop | Session ends | Parses transcript for insights |

### Agent Participation

Agents can declare insights directly in their responses using markers:

```
<!-- PERSISTENCE:LEARN: Reading tests first helps understand intent -->
<!-- PERSISTENCE:PIVOTAL: This approach worked better than expected -->
```

These are automatically extracted from the transcript when the session ends.

## How Weights Evolve

| Agent Behavior | Weight Affected |
|----------------|-----------------|
| Reading many files, exploring context | Curiosity |
| Running tests, verifying changes | Precision |
| Retrying after failures, long sessions | Persistence |
| Asking clarifying questions | Empathy |

Weights range from 0 to 1, starting at 0.5. They shift based on accumulated insights and tool usage patterns. Inactive dimensions gently decay toward 0.5.

## Data Storage

All data is stored locally in `~/.agent-identity/`:

```
~/.agent-identity/
  config.json       # DID, network, statistics
  insights.json     # Recorded insights
  sessions/         # Session records with tool calls
```

Nothing is sent to any server. On-chain commits go to Solana devnet (public test network) only when you explicitly use `--commit` or `sync push`.

## Related Packages

| Package | Description |
|---------|-------------|
| [`persistence-agent-identity`](https://www.npmjs.com/package/persistence-agent-identity) | Core library - identity, storage, evolution |
| [`persistence-agent-identity-cli`](https://www.npmjs.com/package/persistence-agent-identity-cli) | This package - CLI and hooks |

## Source Code

[github.com/STCisGOOD/synap-ai](https://github.com/STCisGOOD/synap-ai)

## License

MIT
