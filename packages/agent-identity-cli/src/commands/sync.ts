/**
 * sync command - Sync identity state with blockchain.
 *
 * Operations:
 * - push: Upload local state to chain
 * - pull: Download chain state to local
 * - status: Compare local and chain state
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  loadConfig,
  saveConfig,
} from '../utils/config';
import {
  error,
  info,
  colors,
  box,
} from '../utils/display';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createSyncCommand(): Command {
  const cmd = new Command('sync')
    .description('Sync identity state with blockchain')
    .argument('[operation]', 'Operation: push, pull, or status (default: status)', 'status')
    .option('--force', 'Force overwrite without confirmation')
    .action(async (operation: string, options) => {
      await runSync(operation, options);
    });

  return cmd;
}

// =============================================================================
// SYNC IMPLEMENTATION
// =============================================================================

interface SyncOptions {
  force?: boolean;
}

async function runSync(operation: string, options: SyncOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  console.log('');

  // Route to appropriate handler
  switch (operation.toLowerCase()) {
    case 'status':
      await handleStatus();
      break;

    case 'push':
      await handlePush(options);
      break;

    case 'pull':
      await handlePull(options);
      break;

    default:
      error(`Unknown operation: ${operation}`);
      info('Valid operations: push, pull, status');
      process.exit(1);
  }
}

// =============================================================================
// OPERATION HANDLERS
// =============================================================================

async function handleStatus(): Promise<void> {
  const spinner = ora('Checking sync status...').start();

  try {
    const agent = await AgentIdentity.load({ offline: false });

    if (agent.isOffline) {
      spinner.warn('Running in offline mode - cannot check chain state');
      console.log('');
      info('Chain sync requires network connectivity');
      info('Local state may differ from on-chain state');
      return;
    }

    spinner.succeed('Connected to blockchain');

    // Compare states
    console.log('');
    console.log(colors.bold('Sync Status'));
    console.log('');

    // Get local state
    const localWeights = agent.weights;
    console.log(colors.secondary('Local State:'));
    console.log(`  Curiosity:   ${localWeights.curiosity.toFixed(3)}`);
    console.log(`  Precision:   ${localWeights.precision.toFixed(3)}`);
    console.log(`  Persistence: ${localWeights.persistence.toFixed(3)}`);
    console.log(`  Empathy:     ${localWeights.empathy.toFixed(3)}`);
    console.log('');

    // Try to get on-chain state
    const checkSpinner = ora('Fetching on-chain state...').start();

    try {
      // This would query the blockchain for stored declarations
      // For now, we indicate this is a future feature
      checkSpinner.info('On-chain state verification coming soon');
      console.log('');
      info('The Anchor program stores declarations on-chain.');
      info('Full state reconstruction from chain is in development.');
    } catch (err) {
      checkSpinner.warn(`Could not fetch on-chain state: ${err}`);
    }

    console.log('');
    console.log(colors.muted('─'.repeat(50)));
    console.log('');
    console.log(colors.secondary('Use:'));
    console.log(`  ${colors.primary('persistence-identity sync push')}  - Push local state to chain`);
    console.log(`  ${colors.primary('persistence-identity sync pull')}  - Pull chain state to local`);
    console.log('');

  } catch (err) {
    spinner.fail(`Failed to check status: ${err}`);
    process.exit(1);
  }
}

async function handlePush(options: SyncOptions): Promise<void> {
  const config = loadConfig();

  console.log(colors.bold('Push Local State to Blockchain'));
  console.log('');

  const spinner = ora('Connecting to blockchain...').start();

  try {
    const agent = await AgentIdentity.load({ offline: false });

    if (agent.isOffline) {
      spinner.fail('Cannot push in offline mode');
      info('Ensure you have network connectivity and try again');
      process.exit(1);
    }

    spinner.succeed('Connected to blockchain');

    // Show what will be pushed
    console.log('');
    console.log(colors.secondary('Data to push:'));
    console.log(`  Curiosity:   ${agent.weights.curiosity.toFixed(3)}`);
    console.log(`  Precision:   ${agent.weights.precision.toFixed(3)}`);
    console.log(`  Persistence: ${agent.weights.persistence.toFixed(3)}`);
    console.log(`  Empathy:     ${agent.weights.empathy.toFixed(3)}`);
    console.log('');

    if (!options.force) {
      info('This will create an on-chain declaration (costs SOL)');
      info('Use --force to proceed without this message');
      console.log('');
      return;
    }

    // Push to chain
    const pushSpinner = ora('Creating on-chain declaration...').start();

    try {
      // Create a weights declaration
      const weightsJson = JSON.stringify(agent.weights);
      const declaration = `weights:${weightsJson}`;

      await agent.declareInsight(declaration, {
        dimension: 'sync',
        isPivotal: false,
        confidence: 1.0,
      });

      // Update sync timestamp
      config.stats.lastEvolution = new Date().toISOString();
      saveConfig(config);

      pushSpinner.succeed('State pushed to blockchain');

      console.log('');
      console.log(box(
        `${colors.success('Push Complete!')}

Your identity state has been recorded on-chain.
This creates an immutable, verifiable record of
your current behavioral profile.

Network: ${config.network}
DID: ${colors.muted(agent.did.slice(0, 40))}...`,
        'Sync Complete'
      ));

    } catch (err) {
      pushSpinner.fail(`Failed to push: ${err}`);

      if (String(err).includes('insufficient')) {
        info('You may need more SOL. For devnet:');
        console.log(`  ${colors.primary('solana airdrop 1')}`);
      }

      process.exit(1);
    }

  } catch (err) {
    spinner.fail(`Failed to connect: ${err}`);
    process.exit(1);
  }

  console.log('');
}

async function handlePull(_options: SyncOptions): Promise<void> {
  console.log(colors.bold('Pull State from Blockchain'));
  console.log('');

  const spinner = ora('Connecting to blockchain...').start();

  try {
    const agent = await AgentIdentity.load({ offline: false });

    if (agent.isOffline) {
      spinner.fail('Cannot pull in offline mode');
      info('Ensure you have network connectivity and try again');
      process.exit(1);
    }

    spinner.succeed('Connected to blockchain');

    // Show current local state
    console.log('');
    console.log(colors.secondary('Current local state:'));
    console.log(`  Curiosity:   ${agent.weights.curiosity.toFixed(3)}`);
    console.log(`  Precision:   ${agent.weights.precision.toFixed(3)}`);
    console.log(`  Persistence: ${agent.weights.persistence.toFixed(3)}`);
    console.log(`  Empathy:     ${agent.weights.empathy.toFixed(3)}`);
    console.log('');

    // Query chain for declarations
    const querySpinner = ora('Querying on-chain declarations...').start();

    try {
      // This would fetch all declarations for this identity
      // and reconstruct the latest state
      // For now, this is a placeholder for the full implementation
      querySpinner.info('Full state reconstruction coming soon');

      console.log('');
      console.log(colors.secondary('On-chain state reconstruction requires:'));
      console.log('  1. Fetching all declarations for this DID');
      console.log('  2. Verifying signatures');
      console.log('  3. Applying declarations in order');
      console.log('  4. Reconstructing current weights');
      console.log('');
      info('This feature is being implemented as part of the Anchor program integration.');

    } catch (err) {
      querySpinner.fail(`Failed to query chain: ${err}`);
    }

  } catch (err) {
    spinner.fail(`Failed to connect: ${err}`);
    process.exit(1);
  }

  console.log('');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createSyncCommand;
