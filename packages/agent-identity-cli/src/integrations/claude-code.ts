/**
 * Claude Code Integration - Hook installation and management.
 *
 * Installs hooks into Claude Code's settings.json to enable
 * automatic session tracking and identity persistence.
 *
 * Security considerations:
 * - Only modifies user's own settings.json
 * - Validates existing settings before merging
 * - Creates backups before modifications
 * - Never executes user-provided commands
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadConfig,
  saveConfig,
} from '../utils/config';
import {
  safeParseJson,
  safeStringifyJson,
} from '../utils/security';

// =============================================================================
// TYPES
// =============================================================================

interface ClaudeCodeHook {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
}

interface ClaudeCodeMatcher {
  matcher: string;
  hooks: ClaudeCodeHook[];
}

interface ClaudeCodeSettings {
  hooks?: {
    SessionStart?: ClaudeCodeMatcher[];
    PreToolUse?: ClaudeCodeMatcher[];
    PostToolUse?: ClaudeCodeMatcher[];
    Stop?: ClaudeCodeMatcher[];
  };
  [key: string]: unknown;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// The command that Claude Code will invoke
const HOOK_COMMAND_BASE = 'persistence-identity hook';

// Our hook identifiers (to detect existing installations)
const HOOK_IDENTIFIER = 'persistence-identity';

// Default timeout for hooks (ms)
const HOOK_TIMEOUT = 5000;

// =============================================================================
// PATH UTILITIES
// =============================================================================

/**
 * Get the path to Claude Code's settings.json.
 *
 * Claude Code stores settings in:
 * - Windows: %USERPROFILE%\.claude\settings.json
 * - macOS/Linux: ~/.claude/settings.json
 */
function getClaudeCodeSettingsPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.claude', 'settings.json');
}

/**
 * Get the path to Claude Code's settings directory.
 */
function getClaudeCodeDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.claude');
}

// =============================================================================
// SETTINGS MANAGEMENT
// =============================================================================

/**
 * Load existing Claude Code settings.
 * Returns empty object if file doesn't exist.
 */
function loadClaudeCodeSettings(): ClaudeCodeSettings {
  const settingsPath = getClaudeCodeSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf8');
    return safeParseJson<ClaudeCodeSettings>(content);
  } catch {
    // If parsing fails, return empty to avoid corrupting existing settings
    throw new Error(`Failed to parse existing settings.json. Please check ${settingsPath} for syntax errors.`);
  }
}

/**
 * Save Claude Code settings.
 * Creates backup of existing file before overwriting.
 */
function saveClaudeCodeSettings(settings: ClaudeCodeSettings): void {
  const settingsPath = getClaudeCodeSettingsPath();
  const claudeDir = getClaudeCodeDir();

  // Ensure .claude directory exists
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  }

  // Create backup if file exists
  if (fs.existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.backup.${Date.now()}`;
    fs.copyFileSync(settingsPath, backupPath);

    // Clean up old backups (keep last 5)
    cleanupOldBackups(claudeDir);
  }

  // Write new settings
  const content = safeStringifyJson(settings, 2);
  fs.writeFileSync(settingsPath, content, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Clean up old backup files, keeping only the most recent ones.
 */
function cleanupOldBackups(dir: string, keep: number = 5): void {
  try {
    const files = fs.readdirSync(dir);
    const backups = files
      .filter(f => f.startsWith('settings.json.backup.'))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        time: parseInt(f.split('.').pop() || '0', 10),
      }))
      .sort((a, b) => b.time - a.time);

    // Remove old backups
    for (let i = keep; i < backups.length; i++) {
      try {
        fs.unlinkSync(backups[i].path);
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// HOOK DETECTION
// =============================================================================

/**
 * Check if our hooks are already installed.
 */
function detectExistingHooks(settings: ClaudeCodeSettings): {
  hasSessionStart: boolean;
  hasPostToolUse: boolean;
  hasStop: boolean;
} {
  const result = {
    hasSessionStart: false,
    hasPostToolUse: false,
    hasStop: false,
  };

  if (!settings.hooks) {
    return result;
  }

  // Check SessionStart
  if (settings.hooks.SessionStart) {
    for (const matcher of settings.hooks.SessionStart) {
      for (const hook of matcher.hooks) {
        if (hook.command?.includes(HOOK_IDENTIFIER)) {
          result.hasSessionStart = true;
          break;
        }
      }
    }
  }

  // Check PostToolUse
  if (settings.hooks.PostToolUse) {
    for (const matcher of settings.hooks.PostToolUse) {
      for (const hook of matcher.hooks) {
        if (hook.command?.includes(HOOK_IDENTIFIER)) {
          result.hasPostToolUse = true;
          break;
        }
      }
    }
  }

  // Check Stop
  if (settings.hooks.Stop) {
    for (const matcher of settings.hooks.Stop) {
      for (const hook of matcher.hooks) {
        if (hook.command?.includes(HOOK_IDENTIFIER)) {
          result.hasStop = true;
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Remove our hooks from settings (for uninstall or reinstall).
 */
function removeOurHooks(settings: ClaudeCodeSettings): ClaudeCodeSettings {
  if (!settings.hooks) {
    return settings;
  }

  const newSettings = { ...settings };
  newSettings.hooks = { ...settings.hooks };

  // Filter out our hooks from each event type
  const eventTypes: Array<keyof NonNullable<ClaudeCodeSettings['hooks']>> = [
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'Stop',
  ];

  for (const eventType of eventTypes) {
    const matchers = newSettings.hooks[eventType];
    if (!matchers) continue;

    // Filter matchers to remove our hooks
    const filteredMatchers = matchers
      .map(matcher => ({
        ...matcher,
        hooks: matcher.hooks.filter(
          hook => !hook.command?.includes(HOOK_IDENTIFIER)
        ),
      }))
      .filter(matcher => matcher.hooks.length > 0);

    if (filteredMatchers.length > 0) {
      newSettings.hooks[eventType] = filteredMatchers;
    } else {
      delete newSettings.hooks[eventType];
    }
  }

  // Remove hooks object if empty
  if (Object.keys(newSettings.hooks).length === 0) {
    delete newSettings.hooks;
  }

  return newSettings;
}

// =============================================================================
// HOOK INSTALLATION
// =============================================================================

/**
 * Create our hook configuration.
 */
function createOurHooks(): NonNullable<ClaudeCodeSettings['hooks']> {
  return {
    SessionStart: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${HOOK_COMMAND_BASE} session-start`,
            timeout: HOOK_TIMEOUT,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${HOOK_COMMAND_BASE} tool-call`,
            timeout: HOOK_TIMEOUT,
            async: true,
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${HOOK_COMMAND_BASE} session-end`,
            timeout: HOOK_TIMEOUT,
          },
        ],
      },
    ],
  };
}

/**
 * Merge our hooks with existing settings.
 * Preserves user's other hooks and settings.
 */
function mergeHooks(settings: ClaudeCodeSettings): ClaudeCodeSettings {
  // First, remove any existing instances of our hooks
  const cleaned = removeOurHooks(settings);

  // Create our hooks
  const ourHooks = createOurHooks();

  // Merge
  const newSettings: ClaudeCodeSettings = {
    ...cleaned,
    hooks: {
      ...cleaned.hooks,
    },
  };

  // Add our hooks to each event type
  for (const [eventType, matchers] of Object.entries(ourHooks)) {
    const key = eventType as keyof typeof ourHooks;
    const existing = newSettings.hooks![key] || [];
    newSettings.hooks![key] = [...existing, ...matchers];
  }

  return newSettings;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export interface InstallHooksOptions {
  force?: boolean;
}

export interface InstallHooksResult {
  success: boolean;
  installed: boolean;
  message: string;
  settingsPath: string;
  backupPath?: string;
}

/**
 * Install Claude Code hooks for persistent identity tracking.
 *
 * This modifies ~/.claude/settings.json to add hooks that will be
 * invoked during Claude Code sessions.
 */
export async function installClaudeCodeHooks(
  options: InstallHooksOptions = {}
): Promise<InstallHooksResult> {
  const settingsPath = getClaudeCodeSettingsPath();

  try {
    // Load existing settings
    const settings = loadClaudeCodeSettings();

    // Check for existing hooks
    const existing = detectExistingHooks(settings);
    const alreadyInstalled =
      existing.hasSessionStart && existing.hasPostToolUse && existing.hasStop;

    if (alreadyInstalled && !options.force) {
      return {
        success: true,
        installed: false,
        message: 'Hooks already installed',
        settingsPath,
      };
    }

    // Merge our hooks with existing settings
    const newSettings = mergeHooks(settings);

    // Save
    saveClaudeCodeSettings(newSettings);

    // Update our config
    const config = loadConfig();
    config.integrations.claudeCode = {
      installed: true,
      installedAt: new Date().toISOString(),
      settingsPath,
    };
    saveConfig(config);

    return {
      success: true,
      installed: true,
      message: options.force ? 'Hooks reinstalled' : 'Hooks installed',
      settingsPath,
    };
  } catch (err) {
    return {
      success: false,
      installed: false,
      message: `Failed to install hooks: ${err}`,
      settingsPath,
    };
  }
}

/**
 * Uninstall Claude Code hooks.
 */
export async function uninstallClaudeCodeHooks(): Promise<InstallHooksResult> {
  const settingsPath = getClaudeCodeSettingsPath();

  try {
    // Load existing settings
    const settings = loadClaudeCodeSettings();

    // Remove our hooks
    const newSettings = removeOurHooks(settings);

    // Save
    saveClaudeCodeSettings(newSettings);

    // Update our config
    const config = loadConfig();
    if (config.integrations.claudeCode) {
      config.integrations.claudeCode.installed = false;
    }
    saveConfig(config);

    return {
      success: true,
      installed: false,
      message: 'Hooks uninstalled',
      settingsPath,
    };
  } catch (err) {
    return {
      success: false,
      installed: false,
      message: `Failed to uninstall hooks: ${err}`,
      settingsPath,
    };
  }
}

/**
 * Check if Claude Code hooks are installed.
 */
export function areClaudeCodeHooksInstalled(): boolean {
  try {
    const settings = loadClaudeCodeSettings();
    const existing = detectExistingHooks(settings);
    return existing.hasSessionStart && existing.hasPostToolUse && existing.hasStop;
  } catch {
    return false;
  }
}

/**
 * Get Claude Code settings path.
 */
export function getSettingsPath(): string {
  return getClaudeCodeSettingsPath();
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  areClaudeCodeHooksInstalled,
  getSettingsPath,
};
