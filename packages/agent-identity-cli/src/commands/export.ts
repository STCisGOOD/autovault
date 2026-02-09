/**
 * export command - Export identity in various formats.
 *
 * Supports exporting to:
 * - JSON (full structured data)
 * - Prompt (for manual inclusion in system prompts)
 * - Markdown (human-readable report)
 * - SEED (for persistence-protocol interop)
 */

import { Command } from 'commander';
import {
  loadConfig,
  loadInsights,
  getUnprocessedSessions,
  type CLIConfig,
} from '../utils/config';
import {
  safeStringifyJson,
  sha256,
} from '../utils/security';
import {
  error,
  info,
} from '../utils/display';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createExportCommand(): Command {
  const cmd = new Command('export')
    .description('Export identity in various formats')
    .option('--format <fmt>', 'Output format: json, prompt, markdown, seed (default: json)', 'json')
    .option('--output <path>', 'Write to file instead of stdout')
    .option('--include-private', 'Include private data (insights, sessions)')
    .option('--compact', 'Compact output (no pretty-printing)')
    .action(async (options) => {
      await runExport(options);
    });

  return cmd;
}

// =============================================================================
// EXPORT IMPLEMENTATION
// =============================================================================

interface ExportOptions {
  format: string;
  output?: string;
  includePrivate?: boolean;
  compact?: boolean;
}

async function runExport(options: ExportOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  // Load identity
  let agent: AgentIdentity;
  try {
    agent = await AgentIdentity.load({ offline: true });
  } catch (err) {
    error(`Failed to load identity: ${err}`);
    process.exit(1);
  }

  // Generate export based on format
  let output: string;

  switch (options.format.toLowerCase()) {
    case 'json':
      output = exportJson(agent, config, options);
      break;

    case 'prompt':
      output = exportPrompt(agent);
      break;

    case 'markdown':
    case 'md':
      output = exportMarkdown(agent, config, options);
      break;

    case 'seed':
      output = exportSeed(agent, config);
      break;

    default:
      error(`Unknown format: ${options.format}`);
      info('Supported formats: json, prompt, markdown, seed');
      process.exit(1);
  }

  // Output
  if (options.output) {
    const fs = await import('fs');
    fs.writeFileSync(options.output, output, 'utf8');
    info(`Exported to: ${options.output}`);
  } else {
    console.log(output);
  }
}

// =============================================================================
// FORMAT HANDLERS
// =============================================================================

function exportJson(
  agent: AgentIdentity,
  config: CLIConfig,
  options: ExportOptions
): string {
  const data: Record<string, unknown> = {
    did: agent.did,
    network: config.network,
    weights: agent.weights,
    stats: {
      sessionsRecorded: config.stats.sessionsRecorded,
      lastEvolution: config.stats.lastEvolution,
    },
    exportedAt: new Date().toISOString(),
  };

  if (options.includePrivate) {
    const insights = loadInsights();
    const sessions = getUnprocessedSessions();

    data.insights = insights.map(i => ({
      text: i.text,
      dimension: i.dimension,
      isPivotal: i.isPivotal,
      confidence: i.confidence,
      createdAt: i.createdAt,
    }));

    data.sessions = sessions.map(s => ({
      id: s.id,
      toolCalls: s.toolCalls.length,
      startedAt: s.startedAt,
    }));
  }

  return safeStringifyJson(data, options.compact ? 0 : 2);
}

function exportPrompt(agent: AgentIdentity): string {
  const guidance = agent.getCompactGuidance();
  const weights = agent.weights;

  const lines = [
    '# Persistent Agent Identity',
    '',
    `DID: ${agent.did}`,
    '',
    '## Behavioral Profile',
    '',
    `- Curiosity: ${formatWeight(weights.curiosity)} - ${describeWeight('curiosity', weights.curiosity)}`,
    `- Precision: ${formatWeight(weights.precision)} - ${describeWeight('precision', weights.precision)}`,
    `- Persistence: ${formatWeight(weights.persistence)} - ${describeWeight('persistence', weights.persistence)}`,
    `- Empathy: ${formatWeight(weights.empathy)} - ${describeWeight('empathy', weights.empathy)}`,
    '',
    '## Guidance',
    '',
    guidance,
    '',
    '---',
    `Generated: ${new Date().toISOString()}`,
  ];

  return lines.join('\n');
}

function exportMarkdown(
  agent: AgentIdentity,
  config: CLIConfig,
  options: ExportOptions
): string {
  const weights = agent.weights;
  const insights = loadInsights();
  const pivotalCount = insights.filter(i => i.isPivotal).length;

  const lines = [
    '# Agent Identity Report',
    '',
    '## Overview',
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| DID | \`${agent.did}\` |`,
    `| Network | ${config.network} |`,
    `| Sessions | ${config.stats.sessionsRecorded} |`,
    `| Last Evolution | ${config.stats.lastEvolution || 'Never'} |`,
    '',
    '## Behavioral Weights',
    '',
    '| Dimension | Weight | Description |',
    '|-----------|--------|-------------|',
    `| Curiosity | ${formatWeight(weights.curiosity)} | ${describeWeight('curiosity', weights.curiosity)} |`,
    `| Precision | ${formatWeight(weights.precision)} | ${describeWeight('precision', weights.precision)} |`,
    `| Persistence | ${formatWeight(weights.persistence)} | ${describeWeight('persistence', weights.persistence)} |`,
    `| Empathy | ${formatWeight(weights.empathy)} | ${describeWeight('empathy', weights.empathy)} |`,
    '',
    '## Insights Summary',
    '',
    `- Total insights: ${insights.length}`,
    `- Pivotal insights: ${pivotalCount}`,
    `- Processed: ${insights.filter(i => i.processed).length}`,
    '',
  ];

  if (options.includePrivate && insights.length > 0) {
    lines.push('## Recent Insights');
    lines.push('');

    const recentInsights = insights.slice(-10);
    for (const insight of recentInsights) {
      const prefix = insight.isPivotal ? '**[PIVOTAL]**' : '';
      const dim = insight.dimension ? `*(${insight.dimension})*` : '';
      lines.push(`- ${prefix} ${insight.text.slice(0, 100)}${insight.text.length > 100 ? '...' : ''} ${dim}`);
    }

    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated: ${new Date().toISOString()}*`);

  return lines.join('\n');
}

function exportSeed(agent: AgentIdentity, config: CLIConfig): string {
  // SEED format for persistence-protocol interop
  // This is a standardized format for cross-agent identity transfer

  const weights = agent.weights;
  const insights = loadInsights().filter(i => i.isPivotal);

  const seedData = {
    '@context': 'https://persistence-protocol.dev/seed/v1',
    type: 'AgentIdentitySeed',
    id: agent.did,
    network: config.network,
    version: '1.0',
    created: new Date().toISOString(),

    // Core behavioral profile
    profile: {
      dimensions: [
        { name: 'curiosity', weight: weights.curiosity },
        { name: 'precision', weight: weights.precision },
        { name: 'persistence', weight: weights.persistence },
        { name: 'empathy', weight: weights.empathy },
      ],
    },

    // Pivotal experiences (hashed for privacy)
    pivotalExperiences: insights.slice(-20).map(i => ({
      hash: hashInsight(i.text),
      dimension: i.dimension,
      confidence: i.confidence,
      timestamp: i.createdAt,
    })),

    // Statistics
    stats: {
      sessionsRecorded: config.stats.sessionsRecorded,
      insightsTotal: loadInsights().length,
      insightsPivotal: insights.length,
      lastEvolution: config.stats.lastEvolution,
    },
  };

  return safeStringifyJson(seedData, 2);
}

// =============================================================================
// HELPERS
// =============================================================================

function formatWeight(value: number): string {
  return value.toFixed(2);
}

function describeWeight(dimension: string, value: number): string {
  const level = value < 0.3 ? 'low' : value < 0.7 ? 'moderate' : 'high';

  const descriptions: Record<string, Record<string, string>> = {
    curiosity: {
      low: 'Focused, task-oriented approach',
      moderate: 'Balanced exploration and execution',
      high: 'Deep exploration before action',
    },
    precision: {
      low: 'Quick iterations, minimal verification',
      moderate: 'Standard testing and validation',
      high: 'Thorough verification at each step',
    },
    persistence: {
      low: 'Quick to seek guidance when blocked',
      moderate: 'Balanced retry behavior',
      high: 'Persistent problem-solving, multiple approaches',
    },
    empathy: {
      low: 'Direct, minimal clarification',
      moderate: 'Standard communication patterns',
      high: 'Frequent clarification, adapts to user style',
    },
  };

  return descriptions[dimension]?.[level] || 'Unknown';
}

function hashInsight(text: string): string {
  return sha256(text).slice(0, 16);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createExportCommand;
