/**
 * Display utilities for the CLI.
 *
 * Handles formatted output, progress indicators, and styling.
 */

import chalk from 'chalk';

// =============================================================================
// COLORS AND STYLES
// =============================================================================

export const colors = {
  // Primary colors
  primary: chalk.cyan,
  secondary: chalk.gray,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,

  // Identity colors
  did: chalk.cyan.bold,
  weight: chalk.magenta,
  dimension: chalk.blue,
  insight: chalk.yellow,

  // Status colors
  high: chalk.green,
  moderate: chalk.yellow,
  low: chalk.red,

  // Misc
  muted: chalk.gray,
  bold: chalk.bold,
  dim: chalk.dim,
};

// =============================================================================
// SYMBOLS
// =============================================================================

export const symbols = {
  success: chalk.green('✓'),
  error: chalk.red('✗'),
  warning: chalk.yellow('⚠'),
  info: chalk.cyan('ℹ'),
  arrow: chalk.cyan('→'),
  bullet: chalk.gray('•'),
  bar: {
    full: '█',
    empty: '░',
  },
};

// =============================================================================
// BOX DRAWING
// =============================================================================

/**
 * Draw a simple box around content.
 */
export function box(content: string, title?: string): string {
  const lines = content.split('\n');
  const maxWidth = Math.max(...lines.map(l => stripAnsi(l).length), title ? stripAnsi(title).length + 4 : 0);
  const width = Math.min(maxWidth + 4, 80);

  const top = title
    ? `┌─ ${title} ${'─'.repeat(Math.max(0, width - stripAnsi(title).length - 5))}┐`
    : `┌${'─'.repeat(width - 2)}┐`;

  const bottom = `└${'─'.repeat(width - 2)}┘`;

  const paddedLines = lines.map(line => {
    const visibleLength = stripAnsi(line).length;
    const padding = ' '.repeat(Math.max(0, width - 4 - visibleLength));
    return `│ ${line}${padding} │`;
  });

  return [top, ...paddedLines, bottom].join('\n');
}

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// =============================================================================
// PROGRESS BAR
// =============================================================================

/**
 * Generate a progress bar.
 */
export function progressBar(value: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;

  const filledStr = symbols.bar.full.repeat(filled);
  const emptyStr = symbols.bar.empty.repeat(empty);

  // Color based on value
  let colorFn: (s: string) => string;
  if (clamped >= 0.7) {
    colorFn = colors.high;
  } else if (clamped >= 0.3) {
    colorFn = colors.moderate;
  } else {
    colorFn = colors.low;
  }

  return colorFn(filledStr) + colors.muted(emptyStr);
}

/**
 * Format a weight value with bar and percentage.
 */
export function formatWeight(value: number, name: string): string {
  const bar = progressBar(value, 10);
  const percentage = `${Math.round(value * 100)}%`;
  const level = value >= 0.7 ? '(high)' : value <= 0.3 ? '(low)' : '(moderate)';

  const levelColor = value >= 0.7 ? colors.high : value <= 0.3 ? colors.low : colors.moderate;

  return `  ${colors.dimension(name.padEnd(14))} ${bar} ${percentage.padStart(4)} ${levelColor(level)}`;
}

/**
 * Format just the weight bar portion (for inline use).
 */
export function formatWeightBar(value: number, width: number = 8): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;

  const filledStr = symbols.bar.full.repeat(filled);
  const emptyStr = symbols.bar.empty.repeat(empty);

  // Color based on value
  let colorFn: (s: string) => string;
  if (clamped >= 0.7) {
    colorFn = colors.high;
  } else if (clamped >= 0.3) {
    colorFn = colors.moderate;
  } else {
    colorFn = colors.low;
  }

  return colorFn(filledStr) + colors.muted(emptyStr);
}

// =============================================================================
// STATUS OUTPUT
// =============================================================================

export interface StatusData {
  did: string;
  network: 'devnet' | 'mainnet';
  weights: Record<string, number>;
  stats: {
    sessions: number;
    toolCalls: number;
    insights: number;
    pivotalInsights: number;
    lastEvolution?: string;
  };
  onChain?: {
    declarationCount: number;
    merkleRoot: string;
    continuityScore: number;
    coherenceScore: number;
    balance: number;
  };
}

/**
 * Format the status output.
 */
export function formatStatus(data: StatusData): string {
  const lines: string[] = [];

  // Header
  lines.push(colors.bold('🆔 Agent Identity Status'));
  lines.push(colors.muted('═'.repeat(60)));
  lines.push('');

  // DID
  lines.push(`${colors.secondary('DID:')} ${colors.did(data.did)}`);
  lines.push(`${colors.secondary('Network:')} ${data.network}`);
  lines.push('');

  // Weights
  lines.push(colors.bold('Behavioral Weights:'));
  for (const [name, value] of Object.entries(data.weights)) {
    lines.push(formatWeight(value, name));
  }
  lines.push('');

  // Statistics
  lines.push(colors.bold('Statistics:'));
  lines.push(`  ${colors.secondary('Sessions:'.padEnd(18))} ${data.stats.sessions.toLocaleString()}`);
  lines.push(`  ${colors.secondary('Tool calls:'.padEnd(18))} ${data.stats.toolCalls.toLocaleString()}`);
  lines.push(`  ${colors.secondary('Insights:'.padEnd(18))} ${data.stats.insights} (${data.stats.pivotalInsights} pivotal)`);
  if (data.stats.lastEvolution) {
    lines.push(`  ${colors.secondary('Last evolution:'.padEnd(18))} ${formatRelativeTime(data.stats.lastEvolution)}`);
  }
  lines.push('');

  // On-chain data
  if (data.onChain) {
    lines.push(colors.bold('On-Chain:'));
    lines.push(`  ${colors.secondary('Declarations:'.padEnd(18))} ${data.onChain.declarationCount}`);
    lines.push(`  ${colors.secondary('Merkle root:'.padEnd(18))} ${data.onChain.merkleRoot.slice(0, 12)}...`);
    lines.push(`  ${colors.secondary('Continuity:'.padEnd(18))} ${(data.onChain.continuityScore * 100).toFixed(1)}%`);
    lines.push(`  ${colors.secondary('Coherence:'.padEnd(18))} ${(data.onChain.coherenceScore * 100).toFixed(1)}%`);
    lines.push(`  ${colors.secondary('Balance:'.padEnd(18))} ${data.onChain.balance.toFixed(4)} SOL`);
  }

  return lines.join('\n');
}

// =============================================================================
// TIME FORMATTING
// =============================================================================

/**
 * Format a relative time string.
 */
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return 'just now';
  } else if (diffMin < 60) {
    return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  } else if (diffHour < 24) {
    return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  } else if (diffDay < 7) {
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// =============================================================================
// MESSAGE FORMATTING
// =============================================================================

/**
 * Print a success message.
 */
export function success(message: string): void {
  console.log(`${symbols.success} ${message}`);
}

/**
 * Print an error message.
 */
export function error(message: string): void {
  console.error(`${symbols.error} ${colors.error(message)}`);
}

/**
 * Print a warning message.
 */
export function warning(message: string): void {
  console.warn(`${symbols.warning} ${colors.warning(message)}`);
}

/**
 * Print an info message.
 */
export function info(message: string): void {
  console.log(`${symbols.info} ${message}`);
}

/**
 * Print a step in a process.
 */
export function step(message: string, status: 'pending' | 'success' | 'error' = 'pending'): void {
  const icon = status === 'success' ? symbols.success : status === 'error' ? symbols.error : symbols.arrow;
  console.log(`${icon} ${message}`);
}

// =============================================================================
// TABLE FORMATTING
// =============================================================================

/**
 * Format data as a simple table.
 */
export function table(rows: Array<[string, string]>, header?: [string, string]): string {
  const allRows = header ? [header, ...rows] : rows;
  const col1Width = Math.max(...allRows.map(r => stripAnsi(r[0]).length));

  const lines: string[] = [];

  if (header) {
    lines.push(`${colors.bold(header[0].padEnd(col1Width))}  ${colors.bold(header[1])}`);
    lines.push(`${'─'.repeat(col1Width)}  ${'─'.repeat(20)}`);
  }

  for (const row of rows) {
    const padding = ' '.repeat(col1Width - stripAnsi(row[0]).length);
    lines.push(`${row[0]}${padding}  ${row[1]}`);
  }

  return lines.join('\n');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  colors,
  symbols,
  box,
  stripAnsi,
  progressBar,
  formatWeight,
  formatWeightBar,
  formatStatus,
  formatRelativeTime,
  success,
  error,
  warning,
  info,
  step,
  table,
};
