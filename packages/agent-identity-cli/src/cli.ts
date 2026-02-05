#!/usr/bin/env node
/**
 * persistence-identity CLI
 *
 * Main entry point for the persistent agent identity CLI.
 *
 * Usage:
 *   persistence-identity init          Initialize identity
 *   persistence-identity status        Show current state
 *   persistence-identity learn <msg>   Record an insight
 *   persistence-identity evolve        Process insights and evolve
 *   persistence-identity inject        Update CLAUDE.md
 *   persistence-identity export        Export identity
 *   persistence-identity sync          Sync with blockchain
 *   persistence-identity install-hooks Install tool hooks
 *   persistence-identity hook <event>  (internal) Hook handler
 */

import { Command } from 'commander';
import {
  createInitCommand,
  createStatusCommand,
  createLearnCommand,
  createEvolveCommand,
  createInjectCommand,
  createExportCommand,
  createSyncCommand,
  createInstallHooksCommand,
  createHookCommand,
} from './commands';
import { colors } from './utils/display';

// =============================================================================
// VERSION AND METADATA
// =============================================================================

const VERSION = '1.0.0';
const DESCRIPTION = 'Persistent AI Agent Identity - Your agent, your identity, your chain';

// =============================================================================
// MAIN PROGRAM
// =============================================================================

const program = new Command();

program
  .name('persistence-identity')
  .description(DESCRIPTION)
  .version(VERSION, '-v, --version', 'Show version number')
  .configureHelp({
    sortSubcommands: true,
  });

// =============================================================================
// REGISTER COMMANDS
// =============================================================================

// Core commands
program.addCommand(createInitCommand());
program.addCommand(createStatusCommand());
program.addCommand(createLearnCommand());
program.addCommand(createEvolveCommand());

// Configuration commands
program.addCommand(createInjectCommand());
program.addCommand(createExportCommand());
program.addCommand(createSyncCommand());
program.addCommand(createInstallHooksCommand());

// Internal commands (not shown in help by default)
program.addCommand(createHookCommand());

// =============================================================================
// CUSTOM HELP
// =============================================================================

program.addHelpText('after', `

${colors.bold('Examples:')}

  ${colors.secondary('# Initialize identity with Claude Code hooks')}
  $ persistence-identity init --claude-code

  ${colors.secondary('# Record an insight you learned')}
  $ persistence-identity learn "Reading tests first helps understand intent"

  ${colors.secondary('# Process insights and evolve')}
  $ persistence-identity evolve --commit

  ${colors.secondary('# Update CLAUDE.md with identity section')}
  $ persistence-identity inject

  ${colors.secondary('# Check current state')}
  $ persistence-identity status --verbose

${colors.bold('Documentation:')}

  https://github.com/autovault/agent-identity
  https://persistence-protocol.dev

${colors.bold('Agent Participation:')}

  Agents can declare insights in their responses using markers:

    <!-- PERSISTENCE:LEARN: Your insight here -->
    <!-- PERSISTENCE:PIVOTAL: A pivotal moment -->

  These are automatically extracted when sessions end.
`);

// =============================================================================
// ERROR HANDLING
// =============================================================================

program.exitOverride((err) => {
  if (err.code === 'commander.help') {
    process.exit(0);
  }
  if (err.code === 'commander.version') {
    process.exit(0);
  }
  if (err.code === 'commander.unknownCommand') {
    console.error('');
    console.error(colors.error(`Unknown command: ${err.message}`));
    console.error('');
    console.error(`Run ${colors.primary('persistence-identity --help')} for available commands`);
    process.exit(1);
  }
  throw err;
});

// Global error handler
process.on('uncaughtException', (err) => {
  console.error('');
  console.error(colors.error('Unexpected error:'), err.message);
  console.error('');
  console.error('Please report this issue at:');
  console.error('  https://github.com/autovault/agent-identity/issues');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('');
  console.error(colors.error('Unhandled promise rejection:'), reason);
  process.exit(1);
});

// =============================================================================
// RUN
// =============================================================================

program.parseAsync(process.argv).catch((err) => {
  console.error(colors.error('Error:'), err.message);
  process.exit(1);
});
