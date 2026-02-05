/**
 * status command - Show current identity state.
 *
 * Displays DID, behavioral weights, statistics, and on-chain info.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  loadConfig,
  loadInsights,
  getUnprocessedSessions,
  getStorageDir,
} from '../utils/config';
import {
  formatStatus,
  colors,
  error,
  type StatusData,
} from '../utils/display';
import { safeStringifyJson } from '../utils/security';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createStatusCommand(): Command {
  const cmd = new Command('status')
    .description('Show current identity state')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Show full details')
    .action(async (options) => {
      await runStatus(options);
    });

  return cmd;
}

// =============================================================================
// STATUS IMPLEMENTATION
// =============================================================================

interface StatusOptions {
  json?: boolean;
  verbose?: boolean;
}

async function runStatus(options: StatusOptions): Promise<void> {
  const config = loadConfig();

  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  // Try to load the full identity for on-chain data
  let agent: AgentIdentity | null = null;
  let onChainData: StatusData['onChain'] | undefined;

  const spinner = ora('Loading identity...').start();

  try {
    agent = await AgentIdentity.load({ offline: false });

    // Try to get on-chain data
    if (!agent.isOffline) {
      try {
        // TODO: Implement actual on-chain data fetching
        // For now, we'll show placeholder data
        onChainData = {
          declarationCount: 0,
          merkleRoot: '0'.repeat(64),
          continuityScore: 1.0,
          coherenceScore: 0.0,
          balance: 0,
        };
      } catch {
        // Ignore on-chain errors
      }
    }

    spinner.stop();
  } catch (err) {
    spinner.stop();
    // Continue with config data only
  }

  // Gather statistics
  const insights = loadInsights();
  const unprocessedSessions = getUnprocessedSessions();
  const totalToolCalls = unprocessedSessions.reduce(
    (sum, s) => sum + s.toolCalls.length,
    0
  );

  // Build status data
  const statusData: StatusData = {
    did: config.did,
    network: config.network,
    weights: agent?.weights || {
      curiosity: 0.5,
      precision: 0.5,
      persistence: 0.5,
      empathy: 0.5,
    },
    stats: {
      sessions: config.stats.sessionsRecorded,
      toolCalls: totalToolCalls,
      insights: insights.length,
      pivotalInsights: insights.filter(i => i.isPivotal).length,
      lastEvolution: config.stats.lastEvolution,
    },
    onChain: onChainData,
  };

  // Output
  if (options.json) {
    console.log(safeStringifyJson(statusData, 2));
  } else {
    console.log('');
    console.log(formatStatus(statusData));

    if (options.verbose) {
      console.log('');
      console.log(colors.bold('Storage:'));
      console.log(`  ${colors.secondary('Directory:'.padEnd(18))} ${getStorageDir()}`);
      console.log(`  ${colors.secondary('Unprocessed:'.padEnd(18))} ${unprocessedSessions.length} sessions, ${insights.filter(i => !i.processed).length} insights`);

      if (config.integrations.claudeCode?.installed) {
        console.log('');
        console.log(colors.bold('Integrations:'));
        console.log(`  ${colors.secondary('Claude Code:'.padEnd(18))} ${colors.success('installed')} (${config.integrations.claudeCode.installedAt})`);
      }

      // Show recent insights
      const recentInsights = insights.slice(-5);
      if (recentInsights.length > 0) {
        console.log('');
        console.log(colors.bold('Recent Insights:'));
        for (const insight of recentInsights) {
          const prefix = insight.isPivotal ? colors.insight('[PIVOTAL]') : colors.muted('[insight]');
          const dim = insight.dimension ? colors.dimension(`(${insight.dimension})`) : '';
          console.log(`  ${prefix} ${insight.text.slice(0, 60)}${insight.text.length > 60 ? '...' : ''} ${dim}`);
        }
      }
    }

    console.log('');
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createStatusCommand;
