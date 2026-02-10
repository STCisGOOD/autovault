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
import * as path from 'path';
import { Command } from 'commander';
import {
  loadConfig,
  saveConfig,
  getStorageDir,
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
import { detectDimension } from '../utils/dimensions';
import { FileSystemStorageBackend } from '../utils/storage-backend';
import { TrajectoryEvaluator } from '../trajectory/TrajectoryEvaluator';
import { TrajectoryStore } from '../trajectory/TrajectoryStore';
import { computeTrajectoryFeatures } from '../trajectory/TrajectoryFeatureExtractor';
import { trajectoryFeaturesToSignals } from '../trajectory/trajectoryBridge';
import { DepGraphManager } from '../trajectory/DepGraphManager';
import { Tier1Debouncer } from '../trajectory/Tier1Debouncer';
import type { BatchMeta, Tier1Metrics } from '../trajectory/types';

// Module-level trajectory singletons (session-scoped lifecycle)
let trajectoryEvaluator: TrajectoryEvaluator | null = null;
let trajectoryStore: TrajectoryStore | null = null;
let trajectoryDepGraph: DepGraphManager | null = null;
let trajectoryDebouncer: Tier1Debouncer | null = null;
let trajectoryWarningEmitted = false;
/** Schema version pinned once at SessionStart (v2.2 fix #23). */
let trajectorySchemaVersion = 1;

/**
 * Lazily initialize trajectory evaluator for the stateless hook model
 * (each hook invocation is a separate Node.js process).
 *
 * Reconstructs evaluator state from existing SQLite snapshots (Tier 0 caches).
 * Dep graph is loaded from SQLite cache (no dep-cruiser call). The debouncer
 * is NOT reconstructed — in stateless mode, Tier 1 triggers run dep-cruiser
 * inline in handleToolCall (with 2s timeout). In daemon mode, the debouncer
 * from SessionStart persists and handles Tier 1 with proper batching.
 */
function ensureTrajectory(sessionId: string, cwd?: string): boolean {
  if (trajectoryEvaluator && trajectoryStore) return true;

  try {
    const dbPath = path.join(getStorageDir(), 'trajectory.db');
    if (!fs.existsSync(dbPath)) return false;

    trajectoryStore = new TrajectoryStore({ dbPath });
    trajectoryStore.initialize();
    trajectorySchemaVersion = trajectoryStore.initSession();

    const trajCwd = cwd || process.cwd();
    trajectoryEvaluator = TrajectoryEvaluator.reconstructFromStore({
      cwd: trajCwd,
      sessionId,
      store: trajectoryStore,
    });

    // Reconstruct dep graph from SQLite cache (sync — no dep-cruiser call).
    // Previous PostToolUse processes may have persisted graph state via dep-cruiser.
    // Loading it here enables isNewFile detection and Tier 1 coupling metrics.
    trajectoryDepGraph = new DepGraphManager({ cwd: trajCwd, store: trajectoryStore });
    if (trajectoryDepGraph.initializeFromCache()) {
      trajectoryEvaluator.updateResolvedGraph(trajectoryDepGraph.asGraphRef());
    }

    return true;
  } catch {
    trajectoryEvaluator = null;
    trajectoryStore = null;
    trajectoryDepGraph = null;
    return false;
  }
}

// =============================================================================
// TYPES
// =============================================================================

interface HookInput {
  // BaseHookInput (all events)
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;

  // PostToolUse-specific
  tool_name?: string;
  tool_input?: unknown;               // varies by tool
  tool_response?: unknown;            // varies by tool — NOT tool_result
  tool_use_id?: string;

  // SessionEnd-specific
  reason?: string;                    // "exit", "clear", "logout", "prompt_input_exit"

  // Legacy fields (kept for backward compat)
  source?: string;
  model?: string;
  prompt?: string;
}

interface HookOutput {
  continue: boolean;
  systemMessage?: string;
  error?: string;
}

// =============================================================================
// GIT SURVIVAL TYPES
// =============================================================================

interface GitPendingRecord {
  sessionId: string;
  commits: string[];
  repoRoot: string;
  timestamp: string;
}

interface GitVerifiedRecord {
  survivalRate: number;
  survived: string[];
  missing: string[];
  sessionId: string;
  timestamp: string;
}

function getGitPendingPath(): string {
  return path.join(getStorageDir(), 'git-pending.json');
}

function getGitVerifiedPath(): string {
  return path.join(getStorageDir(), 'git-verified.json');
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

    // Initialize trajectory evaluator for this session
    try {
      const dbPath = path.join(getStorageDir(), 'trajectory.db');
      trajectoryStore = new TrajectoryStore({ dbPath });
      trajectoryStore.initialize();
      // RT-M7: Restrict trajectory.db permissions to owner-only (Unix: 0o600)
      try { fs.chmodSync(dbPath, 0o600); } catch { /* Windows ignores, Unix enforces */ }
      trajectorySchemaVersion = trajectoryStore.initSession();

      const trajCwd = _input.cwd || process.cwd();
      trajectoryEvaluator = new TrajectoryEvaluator({
        cwd: trajCwd,
        sessionId: validSessionId,
        store: trajectoryStore,
      });
      trajectoryEvaluator.initialize();
      trajectoryWarningEmitted = false;

      // Initialize Tier 1 pipeline: DepGraphManager + Tier1Debouncer.
      //
      // In the current stateless hook model, this process exits after SessionStart
      // returns, so the debouncer dies with it. PostToolUse processes fall back to
      // running dep-cruiser inline (see handleToolCall). The debouncer is kept here
      // because it's the correct architecture for a persistent daemon mode — it
      // provides batching efficiency and shouldCommit() staleness guards that the
      // inline fallback lacks. When the daemon architecture arrives, this code
      // becomes the primary Tier 1 path without any changes.
      trajectoryDepGraph = new DepGraphManager({ cwd: trajCwd, store: trajectoryStore });
      trajectoryDebouncer = new Tier1Debouncer(
        async (files: string[], meta: BatchMeta, shouldCommit: () => boolean) => {
          if (!trajectoryDepGraph || !trajectoryEvaluator || !trajectoryStore) return;
          try {
            const result = await trajectoryDepGraph.runDepCruiser(files);
            if (!shouldCommit()) return; // superseded by newer batch
            if (result) {
              trajectoryDepGraph.updateFromResult(result);
            }
            trajectoryEvaluator.updateResolvedGraph(trajectoryDepGraph.asGraphRef());
            const perFileMetrics = files.map(f => {
              const m = trajectoryDepGraph!.computeMetrics(f);
              const metrics: Tier1Metrics = {
                _tier1_ca: m.ca,
                _tier1_ce: m.ce,
                _tier1_instability: m.instability,
                _tier1_trigger_step_min: meta.triggerStepMin,
                _tier1_trigger_step_max: meta.triggerStepMax,
              };
              return {
                filePath: f,
                metricsJson: metrics as unknown as Record<string, unknown>,
              };
            });
            if (!shouldCommit()) return;
            trajectoryDepGraph.persistGraph(validSessionId, meta.triggerStepMax);
            trajectoryStore.writeBatch(perFileMetrics.map((fm) => ({
              sessionId: validSessionId,
              stepIndex: meta.triggerStepMax,
              timestampMs: Date.now(),
              filePath: fm.filePath,
              toolType: 'tier1-batch',
              granularity: 'file' as const,
              packageName: null,
              fileRole: 'source' as const,
              metricsJson: fm.metricsJson,
              tier: 1 as const,
              schemaVersion: trajectorySchemaVersion,
            })));
          } catch { /* Tier 1 failure is non-fatal */ }
        },
        { debounceMs: 500 },
      );

      // Try to initialize graph from cache (non-blocking — OK if fails)
      trajectoryDepGraph.initializeGraph().catch(() => {});

      // Close trajectory resources — this process exits after handleSessionStart
      // returns, so singletons die anyway. Explicit close checkpoints the WAL
      // so PostToolUse/SessionEnd processes see the schema via ensureTrajectory().
      try { trajectoryStore.close(); } catch { /* ignore */ }
      trajectoryEvaluator = null;
      trajectoryStore = null;
      trajectoryDepGraph = null;
      trajectoryDebouncer = null;
    } catch {
      if (trajectoryStore) {
        try { trajectoryStore.close(); } catch { /* ignore */ }
      }
      trajectoryEvaluator = null;
      trajectoryStore = null;
      trajectoryDepGraph = null;
      trajectoryDebouncer = null;
    }

    // Verify pending git commits from previous session
    try {
      await verifyPendingGitCommits(_input.cwd);
    } catch {
      // Git verification failure is non-fatal
    }

    // Load identity and get guidance (including ARIL directives)
    let systemMessage = '';
    try {
      const agent = await AgentIdentity.load({ offline: true });
      const guidance = agent.getCompactGuidance();

      // Include ARIL guidance if available
      const arilGuidance = agent.getARILGuidanceMarkdown();

      const parts: string[] = [];
      if (guidance && guidance !== 'Balanced behavioral profile - no strong tendencies.') {
        parts.push(guidance);
      }
      if (arilGuidance) {
        parts.push(arilGuidance);
      }

      if (parts.length > 0) {
        systemMessage = `[Persistent Identity: ${agent.did.slice(0, 30)}...]\n${parts.join('\n')}`;
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
 * Detect whether a tool call succeeded.
 *
 * PostToolUse only fires on tool execution success (failures route to
 * PostToolUseFailure which isn't available via CLI hooks). So every
 * PostToolUse event is an implicit success — except for Bash, where
 * the command can fail (non-zero exit code) even though the tool itself ran fine.
 *
 * IMPORTANT: Do NOT use string matching like `includes('error')` —
 * that produces false positives on strings like "fixed the error handling",
 * corrupting R → Shapley → replicator dynamics.
 */
function detectToolSuccess(toolName: string, toolResponse: unknown): boolean {
  if (toolName === 'Bash' && toolResponse && typeof toolResponse === 'object') {
    const resp = toolResponse as Record<string, unknown>;
    if (typeof resp.exit_code === 'number') {
      return resp.exit_code === 0;
    }
  }
  return true;
}

/**
 * Extract git commit SHAs from Bash tool output.
 *
 * Detects the bracket format git uses for commit/cherry-pick output:
 *   [main abc1234] Commit message
 *   [branch-name abc1234] Commit message
 *   [main abc1234] (amend) Commit message
 *
 * NOT detected (documented limitations):
 *   - git merge (produces "Merge made by the 'ort' strategy", no bracket format)
 *   - git rebase (intermediate SHAs during replay)
 *   - Commits made outside the session
 */
export function extractGitCommitSHAs(toolResponse: unknown): string[] {
  const text = typeof toolResponse === 'string'
    ? toolResponse
    : (toolResponse && typeof toolResponse === 'object'
      ? JSON.stringify(toolResponse)
      : '');

  if (!text) return [];

  const shas: string[] = [];
  // Match: [branch-name SHA] where SHA is 7-40 hex chars
  // Branch names can contain dots, underscores, slashes, etc.
  const commitRegex = /\[([^\]]+)\s+([0-9a-f]{7,40})\]/g;
  let match;
  while ((match = commitRegex.exec(text)) !== null) {
    shas.push(match[2]);
  }
  return shas;
}

/**
 * Handle tool call event.
 * - Records tool call to session with enriched data
 * - Detects git commit SHAs from Bash results
 */
async function handleToolCall(sessionId: string, input: HookInput): Promise<HookOutput> {
  try {
    const validSessionId = validateSessionId(sessionId);

    // Ensure session exists
    let session = loadSession(validSessionId);
    if (!session) {
      session = createSession(validSessionId);
    }

    // Record tool call with enriched data for ARIL replay
    if (input.tool_name) {
      addToolCallToSession(validSessionId, {
        tool: input.tool_name,
        timestamp: new Date().toISOString(),
        success: detectToolSuccess(input.tool_name, input.tool_response),
        args: (input.tool_input && typeof input.tool_input === 'object')
          ? input.tool_input as Record<string, unknown> : {},
        result: JSON.stringify(input.tool_response ?? '').slice(0, 4096),
      });

      // Detect git commit SHAs from Bash output
      if (input.tool_name === 'Bash' && input.tool_response) {
        const shas = extractGitCommitSHAs(input.tool_response);
        if (shas.length > 0) {
          // Reload session to get latest state (addToolCallToSession saved it)
          session = loadSession(validSessionId)!;
          if (!session.gitCommits) {
            session.gitCommits = [];
          }
          session.gitCommits.push(...shas);
          saveSession(session);
        }
      }
    }

    // Feed code-modifying tool calls to trajectory evaluator.
    // Content is extracted from the tool payload (already in memory) rather than
    // reading from disk, which avoids race conditions with buffered writes,
    // Windows AV latency on just-written files, and NotebookEdit cell semantics.
    //
    // Lazy-init: each hook invocation is a separate process, so singletons
    // from SessionStart are gone. Reconstruct from SQLite on first use.
    if (!trajectoryEvaluator &&
        (input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'NotebookEdit')) {
      ensureTrajectory(validSessionId, input.cwd);
    }
    if (trajectoryEvaluator &&
        (input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'NotebookEdit')) {
      const args = input.tool_input as Record<string, unknown>;
      const filePath = typeof args?.file_path === 'string'
        ? args.file_path
        : (typeof args?.notebook_path === 'string' ? args.notebook_path : null);
      if (filePath) {
        try {
          const content = extractContentFromPayload(input.tool_name, args, filePath);
          if (content !== null) {
            const result = trajectoryEvaluator.onFileChange(filePath, content, input.tool_name);
            // Tier 1 triggering: two modes depending on architecture.
            if (result.tier1Trigger && trajectoryDebouncer) {
              // Daemon mode: debouncer batches file edits and runs dep-cruiser
              // once per batch (with shouldCommit staleness guard). This is the
              // preferred path — better batching efficiency, fewer dep-cruiser
              // invocations. Active when the process persists (future daemon).
              trajectoryDebouncer.add(filePath, result.snapshot.stepIndex);
            } else if (result.tier1Trigger && trajectoryDepGraph && trajectoryStore) {
              // Stateless fallback: each PostToolUse is a separate process, so the
              // SessionStart debouncer is dead. Run dep-cruiser inline with a 2s
              // timeout to avoid blocking the hook response (dep-cruiser can take
              // 2-5s on large projects, and Claude Code waits for our JSON response).
              // Tradeoff: no batching, no staleness guard, one dep-cruiser per trigger.
              try {
                const DEP_CRUISER_TIMEOUT_MS = 2000;
                const depResult = await Promise.race([
                  trajectoryDepGraph.runDepCruiser([filePath]),
                  new Promise<null>(resolve => setTimeout(() => resolve(null), DEP_CRUISER_TIMEOUT_MS)),
                ]);
                if (depResult) {
                  trajectoryDepGraph.updateFromResult(depResult);
                }
                trajectoryEvaluator.updateResolvedGraph(trajectoryDepGraph.asGraphRef());
                const m = trajectoryDepGraph.computeMetrics(filePath);
                const tier1Metrics: Tier1Metrics = {
                  _tier1_ca: m.ca,
                  _tier1_ce: m.ce,
                  _tier1_instability: m.instability,
                  _tier1_trigger_step_min: result.snapshot.stepIndex,
                  _tier1_trigger_step_max: result.snapshot.stepIndex,
                };
                trajectoryStore.writeBatch([{
                  sessionId: validSessionId,
                  stepIndex: result.snapshot.stepIndex,
                  timestampMs: Date.now(),
                  filePath,
                  toolType: 'tier1-batch',
                  granularity: 'file' as const,
                  packageName: null,
                  fileRole: 'source' as const,
                  metricsJson: tier1Metrics as unknown as Record<string, unknown>,
                  tier: 1 as const,
                  schemaVersion: trajectorySchemaVersion,
                }]);
                trajectoryDepGraph.persistGraph(validSessionId, result.snapshot.stepIndex);
              } catch { /* Tier 1 failure is non-fatal */ }
            }
          }
        } catch {
          if (!trajectoryWarningEmitted) {
            console.warn('[trajectory] Evaluator error on tool call — continuing without trajectory data');
            trajectoryWarningEmitted = true;
          }
        }
      }
    }

    // Flush trajectory data to SQLite before process exit.
    // Each PostToolUse is a separate process — unflushed pending batches are lost.
    if (trajectoryStore) {
      try { trajectoryStore.flush(); } catch { /* non-fatal */ }
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
 * Extract file content for trajectory analysis.
 *
 * - Write: content extracted from tool payload (no disk read)
 * - Edit: reads from disk (post-edit). The Edit payload has old_string/new_string
 *   but not the full file content. Since the tool has already written to disk
 *   before PostToolUse fires, the disk read gets the correct post-edit state.
 *   Known limitation: may hit Windows AV latency on just-written files.
 * - NotebookEdit: reads from disk. Raw .ipynb JSON is NOT valid TypeScript —
 *   the evaluator skips .ipynb files entirely (see TrajectoryEvaluator.onFileChange).
 *
 * Returns null if content cannot be extracted (caller should skip, not crash).
 */
function extractContentFromPayload(
  toolName: string,
  args: Record<string, unknown>,
  filePath: string,
): string | null {
  if (toolName === 'Write') {
    // Write tool has the full file content
    if (typeof args.content === 'string') return args.content;
  }

  if (toolName === 'Edit') {
    // Edit tool has old_string and new_string — apply to current file
    // We must read the file to get the full content, but the edit has already
    // been applied by the tool, so disk content is post-edit.
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  if (toolName === 'NotebookEdit') {
    // NotebookEdit operates on cells; new_source is the cell content.
    // For AST analysis, read the full notebook to get all code cells.
    // Fall back to just the new_source if file read fails.
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      if (typeof args.new_source === 'string') return args.new_source;
      return null;
    }
  }

  return null;
}

/**
 * Handle session end event (fires once per session via SessionEnd hook).
 * - Parses transcript for markers
 * - Processes insights
 * - Replays tool calls through ARIL backward pass
 *
 * NOTE: This uses SessionEnd, NOT Stop. Stop fires every time Claude finishes
 * responding (multiple times per session). SessionEnd fires once when the
 * session actually terminates. Running the ARIL backward pass per-turn would
 * learn from partial sessions — wrong.
 */
async function handleSessionEnd(sessionId: string, input: HookInput): Promise<HookOutput> {
  try {
    const validSessionId = validateSessionId(sessionId);

    // Load session
    const session = loadSession(validSessionId);
    if (!session) {
      // Known bug (GitHub #9188): After /exit + `claude --continue`, all hooks
      // receive the *original* session's session_id, not the resumed session's.
      // If the session file doesn't exist, skip rather than creating a ghost session.
      return {
        continue: true,
        error: 'Session not found (possibly stale session_id from --continue)',
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
            dimension: detectDimension(validatedInsight),
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
            dimension: detectDimension(validatedPivotal),
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

    // === ARIL BACKWARD PASS ===
    // Replay the session's tool calls through the full ARIL pipeline:
    // energy gradients, Shapley attribution, replicator dynamics, Möbius, mode observer
    let arilSummary = '';
    try {
      // Dynamic import to avoid loading heavy identity package on every PostToolUse
      const { createUnifiedIdentity, createFileSystemPrivateStorage } = await import('persistence-agent-identity');

      // 1. Storage backend — survives process restarts
      const stateDir = path.join(getStorageDir(), 'state');
      const storage = new FileSystemStorageBackend(stateDir);

      // 2. Create identity (no auto-save timer — we save manually at the end)
      const identity = createUnifiedIdentity(storage, { autoSaveIntervalMs: 0 });

      // 2.0. Wire private storage for ARIL state persistence.
      // MUST be before initialize() so loadARILState() finds the backend.
      if (config.did) {
        identity.setPrivateStorage(
          createFileSystemPrivateStorage({ agentDid: config.did })
        );
      }

      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // 2.1. Telemetry URL from config file (env vars not accepted — RT2-2)
      if (config.telemetryUrl) {
        identity.setTelemetryUrl(config.telemetryUrl);
      }

      // 2.5. Silent reset guard — if state files exist but sessionCount=0,
      // deserialization may have failed and we'd learn on a blank slate.
      const stateFiles = await storage.keys();
      const sessionCount = identity.getSessionCount();
      if (stateFiles.length > 0 && sessionCount === 0) {
        console.warn('[hook] WARNING: State files exist but sessionCount=0. ' +
          'Possible deserialization failure. Learned state may have been lost.');
      }

      // 3. Start observation
      identity.startObservation(validSessionId);

      // 4. Replay tool calls from session record
      // NOTE: Replayed tool calls do NOT preserve real inter-call timing.
      // All calls are replayed in milliseconds during SessionEnd.
      // Any future timing-dependent logic (pacing analysis, idle detection)
      // would need real timestamps from the session record, not replay order.
      for (const tc of session.toolCalls) {
        identity.recordToolCall(
          tc.tool,
          tc.args ?? {},
          String(tc.result ?? ''),
          tc.success ?? true,
          tc.durationMs ?? 0,
        );
        // Record failures for ARIL error rate signal
        if (tc.success === false) {
          identity.recordFailure(
            `${tc.tool} call failed`,
            'minor', 'retry', 'continued',
          );
        }
      }

      // 5. Build Interaction
      // NOTE: SessionEnd hook does NOT receive prompt or response content.
      // prompt/response are empty — OutcomeEvaluator must not depend on them.
      // Session duration comes from the session record timestamps.
      const interaction = {
        id: validSessionId,
        prompt: '',
        response: '',
        context: {},
        durationMs: session.endedAt
          ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
          : 0,
        timestamp: new Date(session.startedAt).getTime(),
        selfStateSnapshot: {
          w: Array.from(identity.getWeights()),
          m: Array.from(identity.getMomentum()),
        },
      };

      // 5.5. Load git survival signal (cross-session, from previous session's verification)
      const hadVerifiedFile = fs.existsSync(getGitVerifiedPath());
      const gitSignal = loadGitVerifiedSignal();

      // 5.6. Compute trajectory signals (code-level metrics from this session)
      // OutcomeSignal type from agent-identity accepts source: 'git_survived' | 'trajectory' | ...
      const extraSignals: Array<{ source: 'git_survived' | 'trajectory'; value: number; weight: number }> = [];
      if (gitSignal) {
        extraSignals.push({
          source: 'git_survived' as const,
          value: gitSignal.value,
          weight: gitSignal.weight,
        });
      }

      // Lazy-init trajectory for SessionEnd (separate process from SessionStart)
      if (!trajectoryEvaluator || !trajectoryStore) {
        ensureTrajectory(validSessionId, input.cwd);
      }

      if (trajectoryEvaluator && trajectoryStore) {
        try {
          // Drain any pending Tier 1 batch (≤2s within 15s budget).
          // Only fires in daemon mode — in stateless mode, debouncer is null.
          if (trajectoryDebouncer) {
            await trajectoryDebouncer.flush(2000);
          }
          // Flush pending writes so getSnapshotCountByTier() sees complete data.
          // getTrajectory() also flushes, but count queries bypass it.
          trajectoryStore.flush();
          const { features, confidences } = computeTrajectoryFeatures(
            trajectoryEvaluator,
            trajectoryStore,
          );
          const trajSignals = trajectoryFeaturesToSignals(features, confidences);
          extraSignals.push(...trajSignals);

          // Path B: persist raw trajectory + features for future mining
          const snapshotCounts = trajectoryStore.getSnapshotCountByTier(
            trajectoryEvaluator.sessionId,
          );
          trajectoryStore.persistSession(validSessionId, {
            features,
            confidences,
            stepCount: trajectoryEvaluator.getCurrentStep(),
            filesTouched: trajectoryEvaluator.getSeenPaths().size,
            tier0SnapshotCount: snapshotCounts.tier0,
            tier1SnapshotCount: snapshotCounts.tier1,
            tier1Available: trajectoryDepGraph?.isDepCruiserAvailable() ?? false,
          });
        } catch { /* trajectory failure is non-fatal */ }
      }

      if (extraSignals.length > 0) {
        identity.setExtraSignals(extraSignals);
      }

      // 5.8. Feed raw import cache for domain classification
      if (trajectoryEvaluator) {
        try {
          const rawImportCache = trajectoryEvaluator.getRawImportCache();
          if (rawImportCache.size > 0) {
            identity.setImportCache(rawImportCache);
          }
        } catch { /* domain classification failure is non-fatal */ }
      }

      // 6. End observation → ARIL backward pass fires
      await identity.endObservation(interaction);

      // 6.5. Clean up verified file after successful backward pass.
      // Gated on hadVerifiedFile (not gitSignal) to handle the edge case
      // where the file exists but has no actionable commits — without this,
      // empty-but-valid git-verified.json files would accumulate on disk.
      if (hadVerifiedFile) {
        consumeGitVerifiedSignal();
      }

      // 7. Save and shutdown
      await identity.save();
      await identity.shutdown();

      session.processed = true;
      saveSession(session);

      arilSummary = `, ARIL backward pass complete (session #${identity.getSessionCount()})`;

      // === STRATEGY FILE GENERATION ===
      // Write .aril/strategies.md and ensure CLAUDE.md/AGENTS.md reference it.
      // This closes the ARIL v2 feedback loop: session → features → render → inject.
      try {
        const projectDir = input.cwd;
        if (projectDir) {
          const strategyResult = await writeStrategyFile(
            session,
            identity,
            projectDir,
          );
          if (strategyResult) {
            arilSummary += ', strategies updated';
          }
        }
      } catch (stratErr) {
        // Strategy file failure must not block session completion
        console.error('[hook] Strategy file generation failed:', stratErr);
      }
    } catch (err) {
      // ARIL failure must not block session completion
      console.error('[hook] ARIL backward pass failed:', err);
      arilSummary = `, ARIL error: ${String(err).slice(0, 100)}`;
    }

    // === GIT COMMIT SIDECAR ===
    // Persist pending commit SHAs for verification at next SessionStart.
    // Also handle stale sidecar fallback: if git-pending.json > 24h old,
    // verify here instead of waiting for next SessionStart.
    try {
      await writeGitPendingSidecar(session, input.cwd);
    } catch {
      // Git sidecar failure is non-fatal
    }

    // Trajectory evaluator cleanup
    if (trajectoryDebouncer) {
      try { trajectoryDebouncer.cancel(); } catch { /* ignore */ }
      trajectoryDebouncer = null;
    }
    trajectoryDepGraph = null;
    if (trajectoryEvaluator) {
      try { trajectoryEvaluator.shutdown(); } catch { /* ignore */ }
      trajectoryEvaluator = null;
    }
    if (trajectoryStore) {
      try { trajectoryStore.close(); } catch { /* ignore */ }
      trajectoryStore = null;
    }

    // Build summary
    const toolCount = session.toolCalls.length;
    const insightCount = (session.markers?.learns.length || 0) + (session.markers?.pivotals.length || 0);

    let systemMessage = `[Session complete: ${toolCount} tools`;
    if (insightCount > 0) {
      systemMessage += `, ${insightCount} insights recorded`;
    }
    systemMessage += arilSummary;
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

// =============================================================================
// STRATEGY FILE GENERATION (ARIL v2)
// =============================================================================

/**
 * Converts SessionRecord tool calls to ActionLog format for the feature extractor.
 */
function sessionToolCallsToActionLog(
  session: ReturnType<typeof loadSession> & { toolCalls: Array<{ tool: string; timestamp: string; durationMs?: number; success?: boolean; args?: Record<string, unknown>; result?: string }> },
): {
  interactionId: string;
  startTime: number;
  endTime: number;
  toolCalls: Array<{
    readonly id: string;
    readonly timestamp: number;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly result: unknown;
    readonly success: boolean;
    readonly durationMs: number;
    readonly wasRequired: boolean;
    readonly context: string;
  }>;
  decisions: never[];
  failures: never[];
  informationSeeks: never[];
  verifications: never[];
  resourceUsage: {
    tokensUsed: number;
    toolCallCount: number;
    wallTimeMs: number;
    apiCalls: number;
    retriesTotal: number;
  };
} {
  const startTime = new Date(session.startedAt).getTime();
  const endTime = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();

  return {
    interactionId: session.id,
    startTime,
    endTime,
    toolCalls: session.toolCalls.map((tc, i) => ({
      id: `${session.id}-tc-${i}`,
      timestamp: new Date(tc.timestamp).getTime(),
      tool: tc.tool,
      args: tc.args ?? {},
      result: tc.result ?? '',
      success: tc.success ?? true,
      durationMs: tc.durationMs ?? 0,
      wasRequired: true,
      context: '',
    })),
    decisions: [],
    failures: [],
    informationSeeks: [],
    verifications: [],
    resourceUsage: {
      tokensUsed: 0,
      toolCallCount: session.toolCalls.length,
      wallTimeMs: endTime - startTime,
      apiCalls: 0,
      retriesTotal: 0,
    },
  };
}

/**
 * Write .aril/strategies.md and ensure reference files point to it.
 *
 * Strategy features are computed from the session's tool calls.
 * Uses real Shapley attributions from identity if available (post-endObservation),
 * falls back to synthetic proportional attributions for the first session.
 *
 * Returns true if the file was written successfully.
 */
async function writeStrategyFile(
  session: NonNullable<ReturnType<typeof loadSession>>,
  identity: {
    getStrategyAttributions(): import('persistence-agent-identity').DimensionAttribution[] | null;
    getStrategyInteractions(): import('persistence-agent-identity').InteractionTerm[] | null;
    getSessionCount(): number;
    getStrategySessionCount(): number;
  },
  projectDir: string,
): Promise<boolean> {
  // Dynamic imports to avoid loading heavy packages on every PostToolUse
  const { extractStrategyFeatures, featuresToArray, STRATEGY_FEATURE_NAMES, renderStrategies } =
    await import('persistence-agent-identity');

  // Skip if too few tool calls to produce meaningful features
  if (session.toolCalls.length < 3) return false;

  // 1. Convert session tool calls to ActionLog format
  const actionLog = sessionToolCallsToActionLog(session);

  // 2. Extract strategy features
  const features = extractStrategyFeatures(actionLog);
  const featureValues = featuresToArray(features);
  const sessionCount = identity.getSessionCount();

  // 3. Use real Shapley attributions if available, fall back to synthetic
  const realAttrs = identity.getStrategyAttributions();
  const realInteractions = identity.getStrategyInteractions();

  let doc;
  if (realAttrs && realAttrs.length === STRATEGY_FEATURE_NAMES.length) {
    // Real Shapley attributions available → φ= notation
    doc = renderStrategies({
      attributions: realAttrs, features, sessionCount,
      synthetic: false,
      interactions: realInteractions ?? undefined,
    });
  } else {
    // Fallback: synthetic for first session (before endObservation runs)
    const totalFV = featureValues.reduce((a, b) => a + b, 0) || 1;
    const featureConfidences = computeFeatureConfidences(actionLog.toolCalls);
    const syntheticAttrs = STRATEGY_FEATURE_NAMES.map((name: string, i: number) => ({
      dimension: name, index: i,
      shapleyValue: featureValues[i] / totalFV,
      confidence: featureConfidences[i], evidence: [] as string[],
    }));
    doc = renderStrategies({
      attributions: syntheticAttrs, features, sessionCount, synthetic: true,
    });
  }

  // 4. Write .aril/strategies.md
  const arilDir = path.join(projectDir, '.aril');
  if (!fs.existsSync(arilDir)) {
    fs.mkdirSync(arilDir, { recursive: true });
  }
  const strategyPath = path.join(arilDir, 'strategies.md');
  fs.writeFileSync(strategyPath, doc.markdown, 'utf8');

  // 5. Ensure CLAUDE.md and AGENTS.md reference the strategy file
  ensureFileReference(
    path.join(projectDir, 'CLAUDE.md'),
    '@.aril/strategies.md',
  );
  ensureFileReference(
    path.join(projectDir, 'AGENTS.md'),
    '@.aril/strategies.md',
  );

  return true;
}

/** Marker comments used to identify the ARIL reference block. */
const ARIL_REF_START = '<!-- ARIL-STRATEGIES -->';
const ARIL_REF_END = '<!-- /ARIL-STRATEGIES -->';

/**
 * Ensure a file contains the ARIL strategies reference.
 *
 * If the file exists and already has the reference, do nothing.
 * If the file exists but lacks the reference, append it.
 * If the file doesn't exist, do NOT create it — creating CLAUDE.md or AGENTS.md
 * from scratch could surprise users. The reference will be added when the user
 * creates the file themselves.
 */
function ensureFileReference(filePath: string, reference: string): void {
  try {
    if (!fs.existsSync(filePath)) {
      // Don't create instruction files from scratch — that would surprise users.
      // But warn so they know strategies won't be loaded.
      const basename = path.basename(filePath);
      console.warn(
        `[hook] ${basename} not found. Create ${basename} with "@.aril/strategies.md" ` +
        `to load learned strategies into context.`
      );
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Check if reference already exists (with or without marker comments)
    if (content.includes(reference) || content.includes(ARIL_REF_START)) {
      return; // Already present
    }

    // Append the reference block
    const refBlock = `\n\n${ARIL_REF_START}\n${reference}\n${ARIL_REF_END}\n`;
    fs.writeFileSync(filePath, content + refBlock, 'utf8');
  } catch {
    // Reference injection failure is non-fatal
  }
}

// =============================================================================
// CONFIDENCE CALCULATION
// =============================================================================

/** Minimum data points for full confidence in a feature measurement. */
const CONFIDENCE_THRESHOLD = 5;

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Compute per-feature confidence based on relevant data point counts.
 *
 * Each feature's confidence reflects how many relevant observations existed
 * for computing that feature value. A feature with zero relevant events
 * gets zero confidence (the feature wasn't exercised, not "we're unconfident").
 *
 * This is single-session confidence only. Cumulative cross-session confidence
 * will replace this once the attribution bridge is wired.
 */
function computeFeatureConfidences(
  toolCalls: readonly { tool: string; success?: boolean }[],
): [number, number, number, number, number] {
  let editCount = 0;
  let writeCount = 0;
  let bashFailures = 0;
  let contextCallsInFirstThird = 0;

  const firstThirdEnd = Math.ceil(toolCalls.length / 3);

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (EDIT_TOOLS.has(tc.tool)) editCount++;
    if (tc.tool === 'Write') writeCount++;
    if (tc.tool === 'Bash' && tc.success === false) bashFailures++;
    if (i < firstThirdEnd && CONTEXT_TOOLS.has(tc.tool)) contextCallsInFirstThird++;
  }

  const ramp = (n: number) => Math.min(n / CONFIDENCE_THRESHOLD, 1.0);

  return [
    ramp(editCount),                  // read_before_edit
    ramp(editCount),                  // test_after_change
    ramp(contextCallsInFirstThird),   // context_gathering: actual context tool calls, not session length
    ramp(writeCount),                 // output_verification
    ramp(bashFailures),               // error_recovery_speed
  ];
}

// =============================================================================
// GIT COMMIT SURVIVAL
// =============================================================================

/**
 * Write git-pending.json sidecar with commit SHAs from this session.
 * Called at SessionEnd after ARIL backward pass.
 *
 * Also handles stale sidecar fallback: if an existing git-pending.json
 * is older than 24 hours, verify it at SessionEnd instead of waiting
 * for next SessionStart.
 */
async function writeGitPendingSidecar(
  session: NonNullable<ReturnType<typeof loadSession>>,
  cwd?: string,
): Promise<void> {
  // Handle stale sidecar fallback first
  const pendingPath = getGitPendingPath();
  if (fs.existsSync(pendingPath)) {
    try {
      const existing: GitPendingRecord = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      const ageMs = Date.now() - new Date(existing.timestamp).getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        // Stale — verify here instead of waiting for next SessionStart
        await verifyPendingGitCommits(cwd);
      }
    } catch {
      // Corrupt sidecar — delete it
      try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
    }
  }

  // Write new pending commits (if any)
  if (!session.gitCommits || session.gitCommits.length === 0) return;
  if (!cwd) return;

  let repoRoot: string;
  try {
    repoRoot = getGitRepoRoot(cwd);
  } catch {
    // Not a git repo — can't track commit survival
    return;
  }

  const record: GitPendingRecord = {
    sessionId: session.id,
    commits: session.gitCommits,
    repoRoot,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(pendingPath, JSON.stringify(record, null, 2), 'utf8');
}

/**
 * Verify pending git commits from previous session.
 * Called at SessionStart. Writes git-verified.json for consumption
 * by the next SessionEnd's OutcomeEvaluator.
 */
async function verifyPendingGitCommits(cwd?: string): Promise<void> {
  const pendingPath = getGitPendingPath();
  if (!fs.existsSync(pendingPath)) return;

  let pending: GitPendingRecord;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    // Corrupt — delete
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
    return;
  }

  if (!pending.commits || pending.commits.length === 0) {
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
    return;
  }

  // Get current repo root and compare
  let currentRepoRoot: string;
  try {
    currentRepoRoot = getGitRepoRoot(cwd);
  } catch {
    // Not a git repo — can't verify, leave pending for next attempt
    return;
  }

  if (currentRepoRoot !== pending.repoRoot) {
    // Different repo — skip verification, leave pending
    return;
  }

  // Get recent git log
  let gitLogOutput: string;
  try {
    const { execSync } = require('child_process');
    gitLogOutput = execSync('git log --format=%H -100', {
      cwd: currentRepoRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    // git log failed — skip verification
    return;
  }

  const recentSHAs = new Set(gitLogOutput.trim().split('\n').filter(Boolean));

  // Check which commits survived
  const survived: string[] = [];
  const missing: string[] = [];
  for (const sha of pending.commits) {
    // Check both full and abbreviated SHAs
    const found = recentSHAs.has(sha) ||
      Array.from(recentSHAs).some(full => full.startsWith(sha));
    if (found) {
      survived.push(sha);
    } else {
      missing.push(sha);
    }
  }

  const survivalRate = pending.commits.length > 0
    ? survived.length / pending.commits.length
    : 1.0;

  // Write verification result
  const verified: GitVerifiedRecord = {
    survivalRate,
    survived,
    missing,
    sessionId: pending.sessionId,
    timestamp: new Date().toISOString(),
  };

  const verifiedPath = getGitVerifiedPath();
  fs.writeFileSync(verifiedPath, JSON.stringify(verified, null, 2), 'utf8');

  // Delete pending to prevent re-verification
  try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
}

/**
 * Load and consume git verification result (if any).
 * Returns the git_survived signal, or null if no verification available.
 */
export function loadGitVerifiedSignal(): { value: number; weight: number } | null {
  const verifiedPath = getGitVerifiedPath();
  if (!fs.existsSync(verifiedPath)) return null;

  try {
    const verified: GitVerifiedRecord = JSON.parse(fs.readFileSync(verifiedPath, 'utf8'));

    // NOTE: File is NOT deleted here. Deletion happens after endObservation()
    // succeeds (see consumeGitVerifiedSignal). This prevents data loss if the
    // process crashes between reading the signal and completing the ARIL
    // backward pass.

    if (verified.survived.length === 0 && verified.missing.length === 0) {
      return null; // No commits to evaluate
    }

    // Asymmetric scoring:
    // Survival (base case, ~95% of the time) → mild positive +0.2
    // Reversion (informative outlier) → stronger negative -0.4
    const value = verified.survivalRate >= 1.0
      ? 0.2
      : verified.survivalRate <= 0.0
        ? -0.4
        : 0.2 * verified.survivalRate - 0.4 * (1 - verified.survivalRate);

    return { value, weight: 0.10 };
  } catch {
    return null;
  }
}

/**
 * Delete git-verified.json after the signal has been successfully consumed
 * by the ARIL backward pass. Call only after endObservation() completes.
 */
export function consumeGitVerifiedSignal(): void {
  try { fs.unlinkSync(getGitVerifiedPath()); } catch { /* ignore */ }
}

/**
 * Get the git repository root for a directory.
 * Synchronous because it uses execSync internally.
 */
function getGitRepoRoot(cwd?: string): string {
  const { execSync } = require('child_process');
  return execSync('git rev-parse --show-toplevel', {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createHookCommand;
