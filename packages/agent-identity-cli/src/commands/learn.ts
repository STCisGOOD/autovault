/**
 * learn command - Agent-initiated insight declaration.
 *
 * This is how agents participate in their own identity formation.
 * The agent declares what they learned, and it gets stored and incorporated
 * into future evolution cycles.
 */

import { Command } from 'commander';
import {
  loadConfig,
  addInsight,
} from '../utils/config';
import {
  validateInsight,
  validateDimension,
} from '../utils/security';
import {
  success,
  error,
  info,
  colors,
} from '../utils/display';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createLearnCommand(): Command {
  const cmd = new Command('learn')
    .description('Declare that you learned something important')
    .argument('<insight>', 'What you learned (be specific!)')
    .option('--dimension <dim>', 'Associated dimension (curiosity, precision, persistence, empathy)')
    .option('--pivotal', 'Mark as pivotal insight (default: true)')
    .option('--no-pivotal', 'Mark as regular (non-pivotal) insight')
    .option('--confidence <level>', 'Confidence level 0-1 (default: 0.8)', '0.8')
    .action(async (insight: string, options) => {
      await runLearn(insight, options);
    });

  return cmd;
}

// =============================================================================
// DIMENSION DETECTION
// =============================================================================

/**
 * Auto-detect dimension from insight text.
 */
function detectDimension(insight: string): string {
  const lower = insight.toLowerCase();

  // Curiosity patterns
  if (/\b(explor|investigat|dig|search|read|look|discover|learn|context|understand|research|found)\b/.test(lower)) {
    return 'curiosity';
  }

  // Precision patterns
  if (/\b(test|verif|check|confirm|build|lint|type|bug|fix|correct|accura|validat|error|stack)\b/.test(lower)) {
    return 'precision';
  }

  // Persistence patterns
  if (/\b(retry|persist|alternat|try|fail|attempt|keep|workaround|eventually|finally)\b/.test(lower)) {
    return 'persistence';
  }

  // Empathy patterns
  if (/\b(user|clarif|explain|prefer|adapt|question|communicat|style|want|need)\b/.test(lower)) {
    return 'empathy';
  }

  return 'general';
}

// =============================================================================
// LEARN IMPLEMENTATION
// =============================================================================

interface LearnOptions {
  dimension?: string;
  pivotal: boolean;
  confidence: string;
}

async function runLearn(insightText: string, options: LearnOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  // Validate insight
  let validatedInsight: string;
  try {
    validatedInsight = validateInsight(insightText);
  } catch (err) {
    error(`Invalid insight: ${err}`);
    process.exit(1);
  }

  // Validate dimension if provided
  let dimension: string;
  if (options.dimension) {
    try {
      dimension = validateDimension(options.dimension);
      // Validate it's a known dimension
      const knownDimensions = ['curiosity', 'precision', 'persistence', 'empathy', 'general'];
      if (!knownDimensions.includes(dimension)) {
        info(`Unknown dimension '${dimension}' - using as custom dimension`);
      }
    } catch (err) {
      error(`Invalid dimension: ${err}`);
      process.exit(1);
    }
  } else {
    dimension = detectDimension(validatedInsight);
  }

  // Parse confidence
  let confidence = parseFloat(options.confidence);
  if (isNaN(confidence) || confidence < 0 || confidence > 1) {
    error('Confidence must be a number between 0 and 1');
    process.exit(1);
  }

  // Store the insight
  const stored = addInsight({
    text: validatedInsight,
    dimension,
    isPivotal: options.pivotal,
    confidence,
    source: 'cli',
  });

  // Output
  console.log('');
  console.log(colors.bold('📝 Insight Recorded'));
  console.log('');
  console.log(`  ${colors.secondary('Insight:')}    "${validatedInsight.slice(0, 70)}${validatedInsight.length > 70 ? '...' : ''}"`);
  console.log(`  ${colors.secondary('Dimension:')}  ${colors.dimension(dimension)}${options.dimension ? '' : colors.muted(' (auto-detected)')}`);
  console.log(`  ${colors.secondary('Pivotal:')}    ${options.pivotal ? colors.success('yes') : colors.muted('no')}`);
  console.log(`  ${colors.secondary('Confidence:')} ${confidence}`);
  console.log(`  ${colors.secondary('ID:')}         ${colors.muted(stored.id)}`);
  console.log('');

  success('Insight will be incorporated into next evolution cycle');

  // Hint about updating CLAUDE.md
  console.log('');
  info(`Run ${colors.primary('persistence-identity inject')} to update CLAUDE.md with new insights`);
  console.log('');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createLearnCommand;
