/**
 * Integration exports.
 *
 * Provides hook installation for various AI coding tools.
 * Currently supports Claude Code, with architecture for future
 * integrations (Cursor, Gemini CLI, etc.)
 */

export {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  areClaudeCodeHooksInstalled,
  getSettingsPath,
  type InstallHooksOptions,
  type InstallHooksResult,
} from './claude-code';
