/**
 * @persistence/agent-identity-cli
 *
 * CLI and programmatic interface for persistent AI agent identity.
 *
 * This package provides:
 * - CLI commands for identity management
 * - Hook integrations for Claude Code and other tools
 * - AgentIdentity facade for programmatic access
 *
 * @example
 * ```typescript
 * import { AgentIdentity } from '@persistence/agent-identity-cli';
 *
 * const agent = await AgentIdentity.load();
 * agent.learnedSomething("Always read tests first to understand intent");
 * ```
 */

// Main facade - primary programmatic interface
export { AgentIdentity } from './facade/AgentIdentity';

// Integration utilities
export {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  areClaudeCodeHooksInstalled,
  type InstallHooksOptions,
  type InstallHooksResult,
} from './integrations';

// Configuration utilities (for advanced use)
export {
  loadConfig,
  saveConfig,
  loadInsights,
  addInsight,
  getUnprocessedSessions,
  markSessionProcessed,
  type CLIConfig,
  type StoredInsight,
  type SessionRecord,
} from './utils/config';

// Security utilities (for advanced use)
export {
  sanitizePath,
  validateInsight,
  validateDimension,
  safeParseJson,
  safeStringifyJson,
} from './utils/security';

// Display utilities (for custom CLI extensions)
export {
  colors,
  success,
  error,
  info,
  box,
  formatStatus,
  formatWeightBar,
} from './utils/display';
