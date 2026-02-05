/**
 * init command - Initialize persistent identity for an AI agent.
 *
 * Creates the storage directory, generates a keypair, requests devnet SOL,
 * and optionally installs hooks for the specified tool.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import ora from 'ora';
import {
  ensureStorageDir,
  loadConfig,
  getStorageDir,
} from '../utils/config';
import { error, info, colors, box } from '../utils/display';
import { AgentIdentity } from '../facade/AgentIdentity';
import { installClaudeCodeHooks } from '../integrations/claude-code';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize persistent identity for an AI agent')
    .option('--network <network>', 'Network to use (devnet or mainnet)', 'devnet')
    .option('--no-fund', 'Skip devnet airdrop')
    .option('--claude-code', 'Also install Claude Code hooks')
    .option('--cursor', 'Also install Cursor hooks (future)')
    .option('--force', 'Overwrite existing identity')
    .action(async (options) => {
      await runInit(options);
    });

  return cmd;
}

// =============================================================================
// INIT IMPLEMENTATION
// =============================================================================

interface InitOptions {
  network: string;
  fund: boolean;
  claudeCode?: boolean;
  cursor?: boolean;
  force?: boolean;
}

async function runInit(options: InitOptions): Promise<void> {
  console.log('');
  console.log(colors.bold('🔐 Initializing Persistent Identity'));
  console.log('');

  // Validate network
  const network = options.network as 'devnet' | 'mainnet';
  if (network !== 'devnet' && network !== 'mainnet') {
    error(`Invalid network: ${options.network}. Must be 'devnet' or 'mainnet'.`);
    process.exit(1);
  }

  // Warn about mainnet
  if (network === 'mainnet') {
    console.log(colors.warning('⚠️  WARNING: Mainnet uses real SOL. Proceed with caution.'));
    console.log('');
  }

  // Check for existing identity
  const storageDir = getStorageDir();
  const configPath = path.join(storageDir, 'config.json');

  if (fs.existsSync(configPath) && !options.force) {
    const existingConfig = loadConfig();
    if (existingConfig.did) {
      console.log(colors.warning('An identity already exists:'));
      console.log(`  DID: ${colors.did(existingConfig.did)}`);
      console.log('');
      console.log('Use --force to overwrite, or run other commands with existing identity.');
      process.exit(0);
    }
  }

  // Step 1: Create storage directory
  const storageSpinner = ora('Creating storage directory...').start();
  try {
    ensureStorageDir();
    storageSpinner.succeed(`Created ${colors.muted(storageDir)}`);
  } catch (err) {
    storageSpinner.fail('Failed to create storage directory');
    error(String(err));
    process.exit(1);
  }

  // Step 2: Initialize identity (generates keypair, connects to Solana)
  const identitySpinner = ora('Generating Ed25519 keypair...').start();
  let agent: AgentIdentity;

  try {
    agent = await AgentIdentity.initialize({
      network,
      autoFund: options.fund && network === 'devnet',
    });
    identitySpinner.succeed(`Generated keypair: ${colors.did(agent.did)}`);
  } catch (err) {
    identitySpinner.fail('Failed to initialize identity');
    error(String(err));
    process.exit(1);
  }

  // Step 3: Request airdrop (devnet only)
  if (options.fund && network === 'devnet') {
    const airdropSpinner = ora('Requesting devnet SOL...').start();
    try {
      // The identity initialization already handles airdrop via autoFund
      // Just wait a moment for it to confirm
      await new Promise(resolve => setTimeout(resolve, 2000));
      airdropSpinner.succeed('Airdrop received (devnet SOL)');
    } catch (err) {
      airdropSpinner.warn('Airdrop may have failed - you can request manually later');
    }
  }

  // Step 4: Install hooks if requested
  if (options.claudeCode) {
    const hooksSpinner = ora('Installing Claude Code hooks...').start();
    try {
      await installClaudeCodeHooks({ force: options.force });
      hooksSpinner.succeed('Claude Code hooks installed');
    } catch (err) {
      hooksSpinner.warn(`Failed to install hooks: ${err}`);
    }
  }

  if (options.cursor) {
    info('Cursor integration coming soon - use generic integration for now');
  }

  // Step 5: Create initial CLAUDE.md section
  const claudeMdSpinner = ora('Generating CLAUDE.md section...').start();
  try {
    const section = agent.getCLAUDEmdSection();
    const claudeMdPath = path.join(process.cwd(), '.claude', 'CLAUDE.md');

    // Check if .claude directory exists
    const claudeDir = path.join(process.cwd(), '.claude');
    if (fs.existsSync(claudeDir)) {
      // Inject or create CLAUDE.md
      if (fs.existsSync(claudeMdPath)) {
        const existing = fs.readFileSync(claudeMdPath, 'utf8');

        // Check if section already exists
        if (existing.includes('PERSISTENCE-IDENTITY:START')) {
          // Replace existing section
          const updated = existing.replace(
            /<!-- PERSISTENCE-IDENTITY:START[\s\S]*?PERSISTENCE-IDENTITY:END -->/,
            section
          );
          fs.writeFileSync(claudeMdPath, updated);
        } else {
          // Append section
          fs.writeFileSync(claudeMdPath, existing + '\n\n' + section);
        }
      } else {
        fs.writeFileSync(claudeMdPath, section);
      }
      claudeMdSpinner.succeed('Updated CLAUDE.md');
    } else {
      claudeMdSpinner.info('No .claude directory found - run in a Claude Code project to update CLAUDE.md');
    }
  } catch (err) {
    claudeMdSpinner.warn(`Could not update CLAUDE.md: ${err}`);
  }

  // Summary
  console.log('');
  console.log(box(
    `${colors.success('Identity initialized successfully!')}\n\n` +
    `DID: ${colors.did(agent.did)}\n` +
    `Network: ${network}\n` +
    `Storage: ${colors.muted(storageDir)}`,
    'Persistent Identity'
  ));

  console.log('');
  console.log(colors.bold('Next steps:'));
  console.log('');
  if (!options.claudeCode) {
    console.log(`  ${colors.secondary('1.')} Install hooks: ${colors.primary('persistence-identity install-hooks claude-code')}`);
  }
  console.log(`  ${colors.secondary(options.claudeCode ? '1.' : '2.')} Check status:  ${colors.primary('persistence-identity status')}`);
  console.log(`  ${colors.secondary(options.claudeCode ? '2.' : '3.')} Learn more:    ${colors.primary('persistence-identity --help')}`);
  console.log('');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createInitCommand;
