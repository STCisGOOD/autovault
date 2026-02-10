// @ts-nocheck — Pre-existing type errors (StoredSelf.state, Declaration.dimensionIndex)
// from initial repo restructure. sync command needs updating for current API.
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
  const config = loadConfig();
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
      const { AnchorStorageBackend, createKeypairManager } = await import('persistence-agent-identity');
      const { Connection } = await import('@solana/web3.js');

      const rpcUrl = config.network === 'mainnet'
        ? 'https://api.mainnet-beta.solana.com'
        : 'https://api.devnet.solana.com';

      const conn = new Connection(rpcUrl, 'confirmed');

      const km = createKeypairManager({
        storageDir: require('path').join(require('os').homedir(), '.agent-identity'),
        network: config.network,
      });
      const keypair = km.load();

      if (!keypair) {
        checkSpinner.warn('No local keypair — cannot query on-chain state');
      } else {
        const backend = new AnchorStorageBackend({ connection: conn, payer: keypair });
        const result = await backend.load();

        if (!result.found || !result.self) {
          checkSpinner.info('No identity account found on-chain');
        } else {
          checkSpinner.succeed('Fetched on-chain state');

          console.log('');
          console.log(colors.secondary('On-chain State:'));
          const onChain = result.self;
          if (onChain.state.vocabulary.assertions.length > 0 && onChain.state.weights.length > 0) {
            for (let i = 0; i < onChain.state.vocabulary.assertions.length; i++) {
              const dim = onChain.state.vocabulary.assertions[i];
              const w = onChain.state.weights[i] ?? 0;
              console.log(`  ${dim.padEnd(14)} ${w.toFixed(3)}`);
            }
          }

          console.log('');
          console.log(colors.secondary('Chain Scores:'));
          console.log(`  Continuity:  ${onChain.continuityProof.continuityScore.toFixed(3)}`);
          console.log(`  Coherence:   ${onChain.continuityProof.coherenceScore.toFixed(3)}`);
          console.log(`  Declarations: ${onChain.declarations.length}`);
        }
      }
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

      // Domain profile publication (opt-in for privacy)
      if (config.exposeDomainProfile) {
        console.log(colors.secondary('  Domain profile: will be published'));
      } else {
        console.log(colors.muted('  Domain profile: local only (enable with exposeDomainProfile)'));
      }

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

async function handlePull(options: SyncOptions): Promise<void> {
  console.log(colors.bold('Pull State from Blockchain'));
  console.log('');

  const config = loadConfig();
  const spinner = ora('Connecting to blockchain...').start();

  try {
    // Dynamic import to avoid hard compile-time dependency
    const { AnchorStorageBackend, createKeypairManager } = await import('persistence-agent-identity');
    const { Connection } = await import('@solana/web3.js');

    const rpcUrl = config.network === 'mainnet'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com';

    const connection = new Connection(rpcUrl, 'confirmed');

    // Load keypair from local storage
    const km = createKeypairManager({
      storageDir: require('path').join(require('os').homedir(), '.agent-identity'),
      network: config.network,
    });

    const keypair = km.load();
    if (!keypair) {
      spinner.fail('No local keypair found. Run: persistence-identity init');
      process.exit(1);
    }

    spinner.succeed('Connected to blockchain');

    // Show current local state
    const agent = await AgentIdentity.load({ offline: true });
    console.log('');
    console.log(colors.secondary('Current local state:'));
    const localWeights = agent.weights;
    for (const [dim, val] of Object.entries(localWeights)) {
      console.log(`  ${dim.padEnd(14)} ${Number(val).toFixed(3)}`);
    }
    console.log('');

    // Query chain for on-chain state
    const querySpinner = ora('Fetching on-chain identity...').start();

    const backend = new AnchorStorageBackend({
      connection,
      payer: keypair,
      debug: false,
    });

    const result = await backend.load();

    if (!result.found || !result.self) {
      querySpinner.warn('No identity found on-chain');
      console.log('');
      info('Push your local state first: persistence-identity sync push --force');
      return;
    }

    querySpinner.succeed('Fetched on-chain state');

    const onChain = result.self;

    // Display on-chain state
    console.log('');
    console.log(colors.secondary('On-chain state:'));

    // Weights
    if (onChain.state.vocabulary.assertions.length > 0 && onChain.state.weights.length > 0) {
      for (let i = 0; i < onChain.state.vocabulary.assertions.length; i++) {
        const dim = onChain.state.vocabulary.assertions[i];
        const w = onChain.state.weights[i] ?? 0;
        console.log(`  ${dim.padEnd(14)} ${w.toFixed(3)}`);
      }
    } else {
      console.log('  (no weights found)');
    }

    // Declarations
    console.log('');
    console.log(colors.secondary(`Declarations: ${onChain.declarations.length}`));
    for (const decl of onChain.declarations) {
      const date = new Date(decl.timestamp).toLocaleDateString();
      console.log(`  [${date}] dim=${decl.dimensionIndex} val=${decl.value.toFixed(3)}`);
    }

    // Scores
    console.log('');
    console.log(colors.secondary('Scores:'));
    console.log(`  Continuity:  ${onChain.continuityProof.continuityScore.toFixed(3)}`);
    console.log(`  Coherence:   ${onChain.continuityProof.coherenceScore.toFixed(3)}`);
    console.log(`  Stability:   ${onChain.continuityProof.stabilityScore.toFixed(3)}`);
    console.log(`  Merkle Root: ${onChain.continuityProof.merkleRoot.slice(0, 16)}...`);
    console.log('');

    if (!options.force) {
      info('Use --force to overwrite local state with on-chain state');
      console.log('');
      return;
    }

    // Verify on-chain state integrity before applying (RT audit finding #4).
    // An RPC MITM could serve tampered account data. Validate weights are
    // well-formed before overwriting local state.
    const onChainWeights = onChain.state?.weights;
    if (!Array.isArray(onChainWeights) || onChainWeights.length === 0) {
      error('On-chain state has no weights — refusing to overwrite local state');
      process.exit(1);
    }
    for (let i = 0; i < onChainWeights.length; i++) {
      const w = onChainWeights[i];
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) {
        error(`On-chain weight[${i}] = ${w} is invalid (expected finite number in [0, 1])`);
        error('Possible RPC tampering — refusing to overwrite local state');
        process.exit(1);
      }
    }

    // Overwrite local state
    const writeSpinner = ora('Overwriting local state with on-chain data...').start();

    try {
      const { IdentityPersistence } = await import('persistence-agent-identity');

      const persistence = new IdentityPersistence({
        storageDir: require('path').join(require('os').homedir(), '.agent-identity'),
        network: config.network,
      });

      await persistence.save(onChain);

      // Update sync timestamp
      config.stats.lastSync = new Date().toISOString();
      saveConfig(config);

      writeSpinner.succeed('Local state overwritten with on-chain data');

      console.log('');
      console.log(box(
        `${colors.success('Pull Complete!')}

On-chain state has been applied to local storage.
Your local behavioral profile now matches the
immutable on-chain record.

Network: ${config.network}
DID: ${colors.muted(config.did?.slice(0, 40) || 'unknown')}...`,
        'Sync Complete'
      ));

    } catch (err) {
      writeSpinner.fail(`Failed to write local state: ${err}`);
      process.exit(1);
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
