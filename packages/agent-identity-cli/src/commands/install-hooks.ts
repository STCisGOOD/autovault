/**
 * install-hooks command - Install hooks for AI coding tools.
 *
 * Installs hooks that enable automatic session tracking
 * and identity persistence for the specified tool.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  loadConfig,
} from '../utils/config';
import {
  error,
  info,
  colors,
  box,
} from '../utils/display';
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  areClaudeCodeHooksInstalled,
  getSettingsPath,
} from '../integrations/claude-code';

// =============================================================================
// SUPPORTED TOOLS
// =============================================================================

const SUPPORTED_TOOLS = ['claude-code', 'cursor', 'gemini'] as const;
type SupportedTool = typeof SUPPORTED_TOOLS[number];

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createInstallHooksCommand(): Command {
  const cmd = new Command('install-hooks')
    .description('Install hooks for AI coding tools')
    .argument('<tool>', `Tool to install hooks for (${SUPPORTED_TOOLS.join(', ')})`)
    .option('--force', 'Reinstall even if already installed')
    .option('--uninstall', 'Remove hooks instead of installing')
    .action(async (tool: string, options) => {
      await runInstallHooks(tool, options);
    });

  return cmd;
}

// =============================================================================
// INSTALL HOOKS IMPLEMENTATION
// =============================================================================

interface InstallHooksOptions {
  force?: boolean;
  uninstall?: boolean;
}

async function runInstallHooks(tool: string, options: InstallHooksOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  // Validate tool
  const normalizedTool = tool.toLowerCase() as SupportedTool;
  if (!SUPPORTED_TOOLS.includes(normalizedTool)) {
    error(`Unsupported tool: ${tool}`);
    info(`Supported tools: ${SUPPORTED_TOOLS.join(', ')}`);
    process.exit(1);
  }

  console.log('');

  // Route to appropriate handler
  switch (normalizedTool) {
    case 'claude-code':
      await handleClaudeCode(options);
      break;

    case 'cursor':
      handleCursor(options);
      break;

    case 'gemini':
      handleGemini(options);
      break;
  }
}

// =============================================================================
// TOOL-SPECIFIC HANDLERS
// =============================================================================

async function handleClaudeCode(options: InstallHooksOptions): Promise<void> {
  const settingsPath = getSettingsPath();

  if (options.uninstall) {
    const spinner = ora('Uninstalling Claude Code hooks...').start();

    const result = await uninstallClaudeCodeHooks();

    if (result.success) {
      spinner.succeed('Claude Code hooks uninstalled');
      console.log('');
      info(`Settings file: ${settingsPath}`);
    } else {
      spinner.fail(result.message);
      process.exit(1);
    }

    return;
  }

  // Check if already installed
  const alreadyInstalled = areClaudeCodeHooksInstalled();
  if (alreadyInstalled && !options.force) {
    console.log(colors.success('✓ Claude Code hooks already installed'));
    console.log('');
    info(`Settings file: ${settingsPath}`);
    info('Use --force to reinstall');
    return;
  }

  const spinner = ora('Installing Claude Code hooks...').start();

  const result = await installClaudeCodeHooks({ force: options.force });

  if (result.success) {
    spinner.succeed(result.message);

    console.log('');
    console.log(box(
      `${colors.success('Claude Code Integration Active')}

Hooks installed for:
  • ${colors.secondary('SessionStart')} - Identity loaded at session start
  • ${colors.secondary('PostToolUse')}  - Tool calls tracked (async)
  • ${colors.secondary('Stop')}         - Session insights processed

Settings: ${colors.muted(settingsPath)}`,
      'Hooks Installed'
    ));

    console.log('');
    console.log(colors.bold('How it works:'));
    console.log('');
    console.log('  1. When a Claude Code session starts, your identity is loaded');
    console.log('  2. Tool calls are tracked to understand your behavioral patterns');
    console.log('  3. When the session ends, insights are extracted and stored');
    console.log('  4. Your identity evolves based on accumulated insights');
    console.log('');

    console.log(colors.bold('Agent participation:'));
    console.log('');
    console.log('  Add markers to your responses to declare insights:');
    console.log(`    ${colors.muted('<!-- PERSISTENCE:LEARN: Reading tests first helps understand intent -->')}`);
    console.log(`    ${colors.muted('<!-- PERSISTENCE:PIVOTAL: This approach worked better than expected -->')}`);
    console.log('');
    console.log('  Or use the CLI directly:');
    console.log(`    ${colors.primary('persistence-identity learn "Always check types before refactoring"')}`);
    console.log('');
  } else {
    spinner.fail(result.message);
    process.exit(1);
  }
}

function handleCursor(_options: InstallHooksOptions): void {
  console.log(colors.warning('Cursor integration is coming soon.'));
  console.log('');
  console.log('Cursor uses a different extension system. In the meantime, you can:');
  console.log('');
  console.log('  1. Use the CLI directly in terminal:');
  console.log(`     ${colors.primary('persistence-identity learn "Your insight here"')}`);
  console.log('');
  console.log('  2. Add the identity section to your project config:');
  console.log(`     ${colors.primary('persistence-identity inject --path .cursor/config.md --create')}`);
  console.log('');
}

function handleGemini(_options: InstallHooksOptions): void {
  console.log(colors.warning('Gemini CLI integration is coming soon.'));
  console.log('');
  console.log('Gemini CLI uses environment variables for configuration. In the meantime:');
  console.log('');
  console.log('  1. Use the CLI directly:');
  console.log(`     ${colors.primary('persistence-identity learn "Your insight here"')}`);
  console.log('');
  console.log('  2. Export identity for manual inclusion:');
  console.log(`     ${colors.primary('persistence-identity export --format prompt > identity.txt')}`);
  console.log('');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createInstallHooksCommand;
