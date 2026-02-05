/**
 * hook command - Internal command called by installed hooks.
 *
 * This is not meant to be called directly by users. It's invoked by
 * the hooks installed in Claude Code (or other tools) to record
 * session events.
 *
 * Security: Validates all input from stdin to prevent injection attacks.
 */

import * as fs from 'fs';
import { Command } from 'commander';
import {
  loadConfig,
  saveConfig,
  createSession,
  loadSession,
  saveSession,
  addToolCallToSession,
  addInsight,
} from '../utils/config';
import {
  safeParseJson,
  validateSessionId,
  validateInsight,
} from '../utils/security';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// TYPES
// =============================================================================

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  tool_use_id?: string;
  source?: string;
  model?: string;
  reason?: string;
  prompt?: string;
}

interface HookOutput {
  continue: boolean;
  systemMessage?: string;
  error?: string;
}

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createHookCommand(): Command {
  const cmd = new Command('hook')
    .description('Internal command called by installed hooks')
    .argument('<event>', 'Hook event (session-start, tool-call, session-end)')
    .option('--session <id>', 'Session ID (if not in stdin)')
    .action(async (event: string, options) => {
      await runHook(event, options);
    });

  return cmd;
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

interface HookOptions {
  session?: string;
}

async function runHook(event: string, options: HookOptions): Promise<void> {
  // Read input from stdin
  let input: HookInput = {};

  try {
    const stdin = await readStdin();
    if (stdin.trim()) {
      input = safeParseJson<HookInput>(stdin);
    }
  } catch (err) {
    // No stdin or invalid JSON - use options
  }

  // Get session ID from input or options
  const sessionId = input.session_id || options.session || `session_${Date.now()}`;

  // Route to appropriate handler
  let output: HookOutput;

  switch (event) {
    case 'session-start':
      output = await handleSessionStart(sessionId, input);
      break;

    case 'tool-call':
      output = await handleToolCall(sessionId, input);
      break;

    case 'session-end':
      output = await handleSessionEnd(sessionId, input);
      break;

    default:
      output = {
        continue: true,
        error: `Unknown hook event: ${event}`,
      };
  }

  // Output JSON response
  console.log(JSON.stringify(output));
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

/**
 * Handle session start event.
 * - Creates session record
 * - Loads identity
 * - Returns system message with compact guidance
 */
async function handleSessionStart(sessionId: string, _input: HookInput): Promise<HookOutput> {
  try {
    const validSessionId = validateSessionId(sessionId);

    // Create session record
    createSession(validSessionId);

    // Load identity and get guidance
    let systemMessage = '';
    try {
      const agent = await AgentIdentity.load({ offline: true });
      const guidance = agent.getCompactGuidance();
      if (guidance && guidance !== 'Balanced behavioral profile - no strong tendencies.') {
        systemMessage = `[Persistent Identity: ${agent.did.slice(0, 30)}...]\n${guidance}`;
      }
    } catch {
      // Identity not initialized - that's OK
    }

    return {
      continue: true,
      systemMessage: systemMessage || undefined,
    };
  } catch (err) {
    return {
      continue: true,
      error: `session-start error: ${err}`,
    };
  }
}

/**
 * Handle tool call event.
 * - Records tool call to session
 */
async function handleToolCall(sessionId: string, input: HookInput): Promise<HookOutput> {
  try {
    const validSessionId = validateSessionId(sessionId);

    // Ensure session exists
    let session = loadSession(validSessionId);
    if (!session) {
      session = createSession(validSessionId);
    }

    // Record tool call
    if (input.tool_name) {
      addToolCallToSession(validSessionId, {
        tool: input.tool_name,
        timestamp: new Date().toISOString(),
        success: !input.tool_result?.includes('error'),
      });
    }

    return { continue: true };
  } catch (err) {
    return {
      continue: true,
      error: `tool-call error: ${err}`,
    };
  }
}

/**
 * Handle session end event.
 * - Parses transcript for markers
 * - Processes insights
 * - Triggers evolution
 * - Updates CLAUDE.md
 */
async function handleSessionEnd(sessionId: string, input: HookInput): Promise<HookOutput> {
  try {
    const validSessionId = validateSessionId(sessionId);

    // Load session
    const session = loadSession(validSessionId);
    if (!session) {
      return {
        continue: true,
        error: 'Session not found',
      };
    }

    // Parse transcript for markers
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      const markers = parseTranscriptMarkers(input.transcript_path);

      // Store learned insights
      for (const learn of markers.learns) {
        try {
          const validatedInsight = validateInsight(learn);
          addInsight({
            text: validatedInsight,
            dimension: detectDimensionFromText(validatedInsight),
            isPivotal: true,
            confidence: 0.85,
            source: 'marker',
            sessionId: validSessionId,
          });
        } catch {
          // Invalid insight - skip
        }
      }

      // Store pivotal moments
      for (const pivotal of markers.pivotals) {
        try {
          const validatedPivotal = validateInsight(pivotal);
          addInsight({
            text: `[PIVOTAL] ${validatedPivotal}`,
            dimension: detectDimensionFromText(validatedPivotal),
            isPivotal: true,
            confidence: 1.0,
            source: 'marker',
            sessionId: validSessionId,
          });
        } catch {
          // Invalid - skip
        }
      }

      // Update session with markers
      session.markers = markers;
    }

    // Mark session as ended
    session.endedAt = new Date().toISOString();
    saveSession(session);

    // Update stats
    const config = loadConfig();
    config.stats.sessionsRecorded++;
    saveConfig(config);

    // Build summary
    const toolCount = session.toolCalls.length;
    const insightCount = (session.markers?.learns.length || 0) + (session.markers?.pivotals.length || 0);

    let systemMessage = `[Session complete: ${toolCount} tools`;
    if (insightCount > 0) {
      systemMessage += `, ${insightCount} insights recorded`;
    }
    systemMessage += ']';

    return {
      continue: true,
      systemMessage,
    };
  } catch (err) {
    return {
      continue: true,
      error: `session-end error: ${err}`,
    };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read all of stdin (with timeout).
 */
async function readStdin(timeoutMs: number = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    // If stdin is a TTY (no pipe), return empty
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    const timeout = setTimeout(() => {
      resolve(data);
    }, timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Resume stdin if paused
    process.stdin.resume();
  });
}

/**
 * Parse transcript file for PERSISTENCE markers.
 *
 * Looks for:
 * - <!-- PERSISTENCE:LEARN: ... -->
 * - <!-- PERSISTENCE:PIVOTAL: ... -->
 */
function parseTranscriptMarkers(transcriptPath: string): {
  learns: string[];
  pivotals: string[];
} {
  const learns: string[] = [];
  const pivotals: string[] = [];

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Find LEARN markers
    const learnRegex = /<!--\s*PERSISTENCE:LEARN:\s*(.+?)\s*-->/g;
    let match;
    while ((match = learnRegex.exec(content)) !== null) {
      const insight = match[1].trim();
      if (insight && insight.length > 0 && insight.length < 2000) {
        learns.push(insight);
      }
    }

    // Find PIVOTAL markers
    const pivotalRegex = /<!--\s*PERSISTENCE:PIVOTAL:\s*(.+?)\s*-->/g;
    while ((match = pivotalRegex.exec(content)) !== null) {
      const insight = match[1].trim();
      if (insight && insight.length > 0 && insight.length < 2000) {
        pivotals.push(insight);
      }
    }
  } catch {
    // File read error - return empty
  }

  return { learns, pivotals };
}

/**
 * Detect dimension from insight text.
 */
function detectDimensionFromText(text: string): string {
  const lower = text.toLowerCase();

  if (/\b(explor|investigat|dig|search|read|discover|learn|context)\b/.test(lower)) {
    return 'curiosity';
  }
  if (/\b(test|verif|check|build|lint|bug|fix|error|stack)\b/.test(lower)) {
    return 'precision';
  }
  if (/\b(retry|persist|alternat|try|fail|attempt|workaround)\b/.test(lower)) {
    return 'persistence';
  }
  if (/\b(user|clarif|explain|prefer|adapt|communicat)\b/.test(lower)) {
    return 'empathy';
  }

  return 'general';
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createHookCommand;
