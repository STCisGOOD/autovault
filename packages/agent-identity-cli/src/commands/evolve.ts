/**
 * evolve command - Process accumulated insights and evolve identity.
 *
 * This is the core learning loop. It:
 * 1. Processes unprocessed sessions and insights
 * 2. Adjusts behavioral weights based on patterns
 * 3. Optionally commits evolution to chain
 * 4. Updates CLAUDE.md with new guidance
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  loadConfig,
  saveConfig,
  loadInsights,
  saveInsights,
  getUnprocessedSessions,
  markSessionProcessed,
  type StoredInsight,
} from '../utils/config';
import {
  error,
  info,
  colors,
  box,
  formatWeightBar,
} from '../utils/display';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createEvolveCommand(): Command {
  const cmd = new Command('evolve')
    .description('Process insights and evolve identity')
    .option('--dry-run', 'Show what would change without applying')
    .option('--commit', 'Commit evolution to blockchain')
    .option('--inject', 'Also update CLAUDE.md after evolution')
    .option('--min-insights <n>', 'Minimum insights required to evolve (default: 3)', '3')
    .action(async (options) => {
      await runEvolve(options);
    });

  return cmd;
}

// =============================================================================
// EVOLVE IMPLEMENTATION
// =============================================================================

interface EvolveOptions {
  dryRun?: boolean;
  commit?: boolean;
  inject?: boolean;
  minInsights: string;
}

interface WeightDelta {
  dimension: string;
  before: number;
  after: number;
  delta: number;
  reason: string;
}

async function runEvolve(options: EvolveOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  console.log('');
  console.log(colors.bold('🧬 Identity Evolution'));
  console.log('');

  // Load identity
  const spinner = ora('Loading identity...').start();
  let agent: AgentIdentity;

  try {
    agent = await AgentIdentity.load({ offline: !options.commit });
    spinner.succeed(`Loaded identity: ${colors.muted(agent.did.slice(0, 40))}...`);
  } catch (err) {
    spinner.fail(`Failed to load identity: ${err}`);
    process.exit(1);
  }

  // Gather inputs
  const insights = loadInsights().filter(i => !i.processed);
  const sessions = getUnprocessedSessions();

  const minInsights = parseInt(options.minInsights, 10) || 3;

  console.log('');
  console.log(colors.secondary('Inputs:'));
  console.log(`  Unprocessed insights: ${insights.length}`);
  console.log(`  Unprocessed sessions: ${sessions.length}`);
  console.log(`  Total tool calls:     ${sessions.reduce((sum, s) => sum + s.toolCalls.length, 0)}`);
  console.log('');

  // Check if we have enough to evolve
  if (insights.length < minInsights) {
    info(`Not enough insights to evolve (have ${insights.length}, need ${minInsights})`);
    info('Continue working and use "persistence-identity learn" to record insights');
    console.log('');
    return;
  }

  // Calculate weight deltas
  const deltas = calculateWeightDeltas(agent.weights, insights, sessions);

  if (deltas.length === 0) {
    info('No significant patterns detected - identity unchanged');
    console.log('');
    return;
  }

  // Show proposed changes
  console.log(colors.bold('Proposed Changes:'));
  console.log('');

  for (const delta of deltas) {
    const direction = delta.delta > 0 ? colors.success('↑') : colors.error('↓');
    const change = Math.abs(delta.delta).toFixed(3);

    console.log(`  ${colors.dimension(delta.dimension.padEnd(12))} ${formatWeightBar(delta.before)} → ${formatWeightBar(delta.after)} ${direction} ${change}`);
    console.log(`    ${colors.muted(delta.reason)}`);
    console.log('');
  }

  // Dry run - stop here
  if (options.dryRun) {
    console.log(colors.muted('─'.repeat(60)));
    console.log('');
    info('Dry run - no changes applied');
    info('Remove --dry-run to apply these changes');
    console.log('');
    return;
  }

  // Apply changes
  const applySpinner = ora('Applying evolution...').start();

  try {
    // Update weights
    const newWeights = { ...agent.weights };
    for (const delta of deltas) {
      if (delta.dimension in newWeights) {
        newWeights[delta.dimension as keyof typeof newWeights] = delta.after;
      }
    }

    // Apply to agent
    agent.weights = newWeights;

    // Mark insights as processed
    const allInsights = loadInsights();
    for (const insight of allInsights) {
      if (!insight.processed) {
        insight.processed = true;
        insight.processedAt = new Date().toISOString();
      }
    }
    saveInsights(allInsights);

    // Mark sessions as processed
    for (const session of sessions) {
      markSessionProcessed(session.id);
    }

    // Update config stats
    config.stats.lastEvolution = new Date().toISOString();
    saveConfig(config);

    applySpinner.succeed('Evolution applied');
  } catch (err) {
    applySpinner.fail(`Failed to apply evolution: ${err}`);
    process.exit(1);
  }

  // Commit to chain if requested
  if (options.commit) {
    const commitSpinner = ora('Committing to blockchain...').start();

    try {
      // Create a summary insight for the evolution
      const summary = `Evolution: ${deltas.map(d => `${d.dimension} ${d.delta > 0 ? '+' : ''}${d.delta.toFixed(3)}`).join(', ')}`;

      await agent.declareInsight(summary, {
        dimension: 'evolution',
        isPivotal: true,
        confidence: 0.9,
      });

      commitSpinner.succeed('Committed to blockchain');
    } catch (err) {
      commitSpinner.warn(`Blockchain commit failed: ${err}`);
      info('Evolution applied locally - will retry commit later');
    }
  }

  // Update CLAUDE.md if requested
  if (options.inject) {
    const injectSpinner = ora('Updating CLAUDE.md...').start();

    try {
      const { execSync } = await import('child_process');
      execSync('persistence-identity inject', { stdio: 'ignore' });
      injectSpinner.succeed('Updated CLAUDE.md');
    } catch {
      injectSpinner.warn('Could not update CLAUDE.md - run "persistence-identity inject" manually');
    }
  }

  // Summary
  console.log('');
  console.log(box(
    `${colors.success('Identity evolved successfully!')}

Processed:
  • ${insights.length} insights
  • ${sessions.length} sessions

Changes:
${deltas.map(d => `  • ${d.dimension}: ${d.delta > 0 ? '+' : ''}${d.delta.toFixed(3)}`).join('\n')}

${options.commit ? colors.success('✓ Committed to blockchain') : colors.muted('Not committed (use --commit)')}`,
    'Evolution Complete'
  ));

  console.log('');
}

// =============================================================================
// WEIGHT CALCULATION
// =============================================================================

interface SessionData {
  id: string;
  toolCalls: Array<{
    tool: string;
    timestamp: string;
    success?: boolean;
  }>;
}

/**
 * Calculate weight deltas based on insights and session data.
 *
 * This is a simplified heuristic-based approach. In production,
 * this could use more sophisticated ML models.
 */
function calculateWeightDeltas(
  currentWeights: Record<string, number>,
  insights: StoredInsight[],
  sessions: SessionData[]
): WeightDelta[] {
  const deltas: WeightDelta[] = [];

  // Count insights by dimension
  const dimensionCounts: Record<string, number> = {};
  const dimensionConfidence: Record<string, number[]> = {};

  for (const insight of insights) {
    const dim = insight.dimension || 'general';
    dimensionCounts[dim] = (dimensionCounts[dim] || 0) + 1;
    if (!dimensionConfidence[dim]) {
      dimensionConfidence[dim] = [];
    }
    dimensionConfidence[dim].push(insight.confidence);
  }

  // Analyze tool usage patterns
  let totalToolCalls = 0;
  let readCalls = 0;
  let editCalls = 0;
  let testCalls = 0;
  let askCalls = 0;

  for (const session of sessions) {
    for (const call of session.toolCalls) {
      totalToolCalls++;
      const tool = call.tool.toLowerCase();

      if (tool.includes('read') || tool.includes('glob') || tool.includes('grep')) {
        readCalls++;
      }
      if (tool.includes('edit') || tool.includes('write')) {
        editCalls++;
      }
      if (tool.includes('bash') && (call.tool.includes('test') || call.tool.includes('npm'))) {
        testCalls++;
      }
      if (tool.includes('ask')) {
        askCalls++;
      }
    }
  }

  // Calculate curiosity delta (based on reading/exploring)
  const curiosityInsights = dimensionCounts['curiosity'] || 0;
  const readRatio = totalToolCalls > 0 ? readCalls / totalToolCalls : 0;

  if (curiosityInsights > 0 || readRatio > 0.4) {
    const boost = Math.min(0.05, curiosityInsights * 0.01 + readRatio * 0.03);
    if (boost > 0.005) {
      const newValue = Math.min(1, currentWeights.curiosity + boost);
      deltas.push({
        dimension: 'curiosity',
        before: currentWeights.curiosity,
        after: newValue,
        delta: newValue - currentWeights.curiosity,
        reason: `${curiosityInsights} curiosity insights, ${(readRatio * 100).toFixed(0)}% read operations`,
      });
    }
  }

  // Calculate precision delta (based on testing/verification)
  const precisionInsights = dimensionCounts['precision'] || 0;
  const testRatio = totalToolCalls > 0 ? testCalls / totalToolCalls : 0;

  if (precisionInsights > 0 || testRatio > 0.1) {
    const boost = Math.min(0.05, precisionInsights * 0.015 + testRatio * 0.05);
    if (boost > 0.005) {
      const newValue = Math.min(1, currentWeights.precision + boost);
      deltas.push({
        dimension: 'precision',
        before: currentWeights.precision,
        after: newValue,
        delta: newValue - currentWeights.precision,
        reason: `${precisionInsights} precision insights, ${(testRatio * 100).toFixed(0)}% test operations`,
      });
    }
  }

  // Calculate persistence delta (based on retries and persistence insights)
  const persistenceInsights = dimensionCounts['persistence'] || 0;
  const avgSessionLength = sessions.length > 0
    ? sessions.reduce((sum, s) => sum + s.toolCalls.length, 0) / sessions.length
    : 0;

  if (persistenceInsights > 0 || avgSessionLength > 20) {
    const boost = Math.min(0.05, persistenceInsights * 0.02 + (avgSessionLength > 20 ? 0.02 : 0));
    if (boost > 0.005) {
      const newValue = Math.min(1, currentWeights.persistence + boost);
      deltas.push({
        dimension: 'persistence',
        before: currentWeights.persistence,
        after: newValue,
        delta: newValue - currentWeights.persistence,
        reason: `${persistenceInsights} persistence insights, avg ${avgSessionLength.toFixed(0)} tools/session`,
      });
    }
  }

  // Calculate empathy delta (based on user communication)
  const empathyInsights = dimensionCounts['empathy'] || 0;
  const askRatio = totalToolCalls > 0 ? askCalls / totalToolCalls : 0;

  if (empathyInsights > 0 || askRatio > 0.05) {
    const boost = Math.min(0.05, empathyInsights * 0.02 + askRatio * 0.1);
    if (boost > 0.005) {
      const newValue = Math.min(1, currentWeights.empathy + boost);
      deltas.push({
        dimension: 'empathy',
        before: currentWeights.empathy,
        after: newValue,
        delta: newValue - currentWeights.empathy,
        reason: `${empathyInsights} empathy insights, ${(askRatio * 100).toFixed(0)}% clarification requests`,
      });
    }
  }

  // Apply decay to dimensions with no activity (very gentle)
  const activeDimensions = new Set(deltas.map(d => d.dimension));

  for (const dim of ['curiosity', 'precision', 'persistence', 'empathy'] as const) {
    if (!activeDimensions.has(dim) && currentWeights[dim] > 0.5) {
      // Very gentle decay towards 0.5 baseline
      const decay = (currentWeights[dim] - 0.5) * 0.02;
      if (decay > 0.005) {
        deltas.push({
          dimension: dim,
          before: currentWeights[dim],
          after: currentWeights[dim] - decay,
          delta: -decay,
          reason: 'No recent activity - gentle regression to baseline',
        });
      }
    }
  }

  return deltas;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createEvolveCommand;
