/**
 * AgentIdentity Facade
 *
 * Simple, secure API for agents to interact with their persistent identity.
 * Wraps the complex internals into a clean interface.
 *
 * Security considerations:
 * - All inputs are validated before use
 * - File paths are sanitized to prevent traversal
 * - Sensitive data is never logged
 * - Atomic file operations prevent corruption
 */

import {
  validateInsight,
  validateDimension,
  validateSessionId,
  generateSecureSessionId,
  redactSensitive,
} from '../utils/security';
import {
  loadConfig,
  saveConfig,
  ensureStorageDir,
  addInsight,
  loadInsights,
  getUnprocessedInsights,
  markInsightsProcessed,
  createSession,
  saveSession,
  addToolCallToSession,
  type CLIConfig,
  type StoredInsight,
  type SessionRecord,
} from '../utils/config';

// =============================================================================
// TYPES
// =============================================================================

export interface LoadOptions {
  /** Storage directory (default: ~/.agent-identity) */
  storageDir?: string;

  /** Network: devnet or mainnet (default: devnet) */
  network?: 'devnet' | 'mainnet';

  /** Auto-fund from faucet if low balance */
  autoFund?: boolean;

  /** Path to existing keypair */
  keypairPath?: string;

  /** Don't connect to Solana (offline mode) */
  offline?: boolean;
}

export interface ToolCallRecord {
  /** Tool name (e.g., 'Read', 'Write', 'Bash') */
  tool: string;

  /** Tool arguments */
  args?: Record<string, unknown>;

  /** Result summary (truncated for storage) */
  result?: string;

  /** Whether the call succeeded */
  success: boolean;

  /** Duration in milliseconds */
  durationMs?: number;
}

export interface InsightDeclaration {
  /** The insight observation */
  observation: string;

  /** Associated dimension (auto-detected if not provided) */
  dimension?: string;

  /** Whether this is a pivotal insight */
  isPivotal?: boolean;

  /** Confidence level (0-1, default 0.9) */
  confidence?: number;
}

export interface SessionContext {
  /** Original prompt/task */
  prompt?: string;

  /** Final response */
  response?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface EvolutionResult {
  /** Summary of changes */
  summary: string;

  /** Weight changes by dimension */
  weightChanges: Record<string, { before: number; after: number; delta: number }>;

  /** Number of insights processed */
  insightsProcessed: number;

  /** Number of sessions processed */
  sessionsProcessed: number;

  /** Whether changes were saved to chain */
  savedToChain: boolean;
}

/**
 * Runtime API surface of BootstrappedIdentity from the core package.
 *
 * Defined locally to decouple CLI compile-time types from the core package.
 * The core package is dynamically imported at runtime, so we describe only
 * the methods and properties the facade actually uses.
 *
 * See: persistence-agent-identity/src/bootstrap/AgentIdentityBootstrap.ts
 */
interface ConnectedIdentity {
  readonly did: string;
  readonly publicKey: string;
  readonly network: string;
  readonly isNew: boolean;
  readonly balance: number;

  startObservation(interactionId: string): void;

  endObservation(interaction: {
    id: string;
    prompt: string;
    response: string;
    timestamp: number;
    durationMs: number;
  }): Promise<{ bridgeResult?: { summary?: string } }>;

  getStatus(): {
    initialized: boolean;
    weights: number[];
    dimensions: string[];
    declarationCount: number;
    pendingChanges: boolean;
  };

  save(): Promise<boolean>;
  shutdown(): Promise<void>;
}

// =============================================================================
// DIMENSION DETECTION
// =============================================================================

/**
 * Auto-detect dimension from insight text.
 * Uses keyword matching to identify the most relevant dimension.
 */
function detectDimension(insight: string): string {
  const lower = insight.toLowerCase();

  // Curiosity patterns
  if (/\b(explor|investigat|dig|search|read.*file|look.*into|discover|learn|understand|context)\b/.test(lower)) {
    return 'curiosity';
  }

  // Precision patterns
  if (/\b(test|verif|check|confirm|build|lint|type.*error|bug|fix|correct|accura|validat)\b/.test(lower)) {
    return 'precision';
  }

  // Persistence patterns
  if (/\b(retry|persist|alternat|try.*again|fail.*then|attempt|keep.*trying|workaround)\b/.test(lower)) {
    return 'persistence';
  }

  // Empathy patterns
  if (/\b(user|clarif|explain|prefer|adapt|question|understand.*need|communicat|style)\b/.test(lower)) {
    return 'empathy';
  }

  return 'general';
}

// =============================================================================
// AGENT IDENTITY CLASS
// =============================================================================

/**
 * AgentIdentity - The main facade for agent identity operations.
 *
 * @example
 * ```typescript
 * const me = await AgentIdentity.load();
 *
 * me.startSession('session-123');
 * me.recordToolCall({ tool: 'Read', args: { file: 'foo.ts' }, success: true });
 * me.learnedSomething("Stack overflow = move content off-chain");
 *
 * await me.endSession({ prompt: 'Fix the bug', response: 'Fixed!' });
 * await me.save();
 * ```
 */
export class AgentIdentity {
  private config: CLIConfig;
  private currentSession: SessionRecord | null = null;
  private internalIdentity: ConnectedIdentity | null = null;
  private offline: boolean;
  private cachedWeights: Record<string, number> | null = null;

  private constructor(config: CLIConfig, offline: boolean = false) {
    this.config = config;
    this.offline = offline;
  }

  // ===========================================================================
  // STATIC FACTORY METHODS
  // ===========================================================================

  /**
   * Load existing identity or create a new one.
   *
   * @param options - Load options
   * @returns AgentIdentity instance
   */
  static async load(options?: LoadOptions): Promise<AgentIdentity> {
    // Ensure storage directory exists
    ensureStorageDir();

    // Load or create config
    const config = loadConfig();

    // Apply options
    if (options?.network) {
      config.network = options.network;
    }

    if (options?.autoFund !== undefined) {
      config.autoFund = options.autoFund;
    }

    const offline = options?.offline ?? false;

    // If we have a DID and not offline, try to connect to the actual identity
    if (config.did && !offline) {
      try {
        // Dynamic import to avoid hard compile-time dependency on the core package
        const { initializeAgentIdentity } = await import('persistence-agent-identity');

        const identity: ConnectedIdentity = await initializeAgentIdentity({
          autoFund: config.autoFund,
          useSolanaStorage: true,
          usePrivateStorage: true,
          // Map network to RPC URL — core defaults to devnet
          ...(config.network === 'mainnet'
            ? { solanaRpcUrl: 'https://api.mainnet-beta.solana.com' }
            : {}),
        });

        const agent = new AgentIdentity(config, false);
        agent.internalIdentity = identity;

        // Update config with latest DID from the bootstrapped identity
        if (identity.did && identity.did !== config.did) {
          config.did = identity.did;
          saveConfig(config);
        }

        return agent;
      } catch (err) {
        console.warn(`[AgentIdentity] Failed to connect to identity, running in offline mode: ${redactSensitive(String(err))}`);
        return new AgentIdentity(config, true);
      }
    }

    return new AgentIdentity(config, offline);
  }

  /**
   * Initialize a new identity (used by init command).
   */
  static async initialize(options?: LoadOptions): Promise<AgentIdentity> {
    ensureStorageDir();

    const config = loadConfig();

    if (options?.network) {
      config.network = options.network;
    }

    if (options?.autoFund !== undefined) {
      config.autoFund = options.autoFund;
    }

    try {
      const { initializeAgentIdentity } = await import('persistence-agent-identity');

      const identity: ConnectedIdentity = await initializeAgentIdentity({
        autoFund: config.autoFund,
        useSolanaStorage: true,
        usePrivateStorage: true,
        ...(config.network === 'mainnet'
          ? { solanaRpcUrl: 'https://api.mainnet-beta.solana.com' }
          : {}),
      });

      // Save DID to config from the bootstrapped identity
      config.did = identity.did;
      config.createdAt = new Date().toISOString();
      saveConfig(config);

      const agent = new AgentIdentity(config, false);
      agent.internalIdentity = identity;

      return agent;
    } catch (err) {
      throw new Error(`Failed to initialize identity: ${redactSensitive(String(err))}`);
    }
  }

  // ===========================================================================
  // IDENTITY GETTERS
  // ===========================================================================

  /**
   * Get the agent's DID.
   */
  get did(): string {
    return this.config.did || 'not-initialized';
  }

  /**
   * Get the network.
   */
  get network(): 'devnet' | 'mainnet' {
    return this.config.network;
  }

  /**
   * Check if running in offline mode.
   */
  get isOffline(): boolean {
    return this.offline;
  }

  /**
   * Get current weights as a simple object.
   *
   * The core package stores weights as parallel arrays (number[] + string[]).
   * This getter converts them to a Record<string, number> for ergonomic use.
   */
  get weights(): Record<string, number> {
    // Return cached weights if they've been set locally
    if (this.cachedWeights) {
      return { ...this.cachedWeights };
    }

    // Convert parallel arrays from core identity to Record
    if (this.internalIdentity) {
      const status = this.internalIdentity.getStatus();
      if (status.dimensions.length > 0 && status.weights.length > 0) {
        const weights: Record<string, number> = {};
        for (let i = 0; i < status.dimensions.length; i++) {
          weights[status.dimensions[i]] = status.weights[i] ?? 0.5;
        }
        return weights;
      }
    }

    // Default weights if not connected
    return { ...this.defaultWeights };
  }

  /**
   * Set weights (used during evolution).
   * Cached locally — persisted to chain on next save().
   */
  set weights(newWeights: Record<string, number>) {
    // Validate weights are in range [0, 1]
    const validated: Record<string, number> = {};
    for (const [key, value] of Object.entries(newWeights)) {
      validated[key] = Math.max(0, Math.min(1, value));
    }

    this.cachedWeights = validated;
  }

  private get defaultWeights(): Record<string, number> {
    return {
      curiosity: 0.5,
      precision: 0.5,
      persistence: 0.5,
      empathy: 0.5,
    };
  }

  /**
   * Get the configuration.
   */
  getConfig(): CLIConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // GUIDANCE GENERATION
  // ===========================================================================

  /**
   * Get behavioral guidance for system prompt injection.
   * This is what goes into CLAUDE.md or similar config files.
   */
  getSystemPromptGuidance(): string {
    const weights = this.weights;
    const insights = loadInsights().filter(i => i.isPivotal);

    const lines: string[] = [];

    // Behavioral profile
    lines.push('### Behavioral Profile\n');
    lines.push('| Dimension | Weight | Guidance |');
    lines.push('|-----------|--------|----------|');

    for (const [dim, value] of Object.entries(weights)) {
      const level = value >= 0.7 ? '**High**' : value <= 0.3 ? 'Low' : 'Moderate';
      const guidance = this.getDimensionGuidance(dim, value);
      lines.push(`| ${this.capitalize(dim)} | ${Math.round(value * 100)}% | ${level} - ${guidance} |`);
    }

    // Learned intuitions
    if (insights.length > 0) {
      lines.push('\n### Learned Intuitions\n');
      lines.push('These insights persist across sessions:\n');

      // Group by dimension
      const byDimension = new Map<string, StoredInsight[]>();
      for (const insight of insights) {
        const dim = insight.dimension || 'general';
        if (!byDimension.has(dim)) {
          byDimension.set(dim, []);
        }
        byDimension.get(dim)!.push(insight);
      }

      for (const [dim, dimInsights] of byDimension) {
        if (dim !== 'general') {
          lines.push(`\n#### ${this.capitalize(dim)}`);
        }
        for (const insight of dimInsights.slice(0, 5)) {
          lines.push(`- ${insight.text}`);
        }
      }
    }

    // Session guidance
    lines.push('\n### Session Guidance\n');
    lines.push('Based on my profile, I should:');

    const highDims = Object.entries(weights).filter(([, v]) => v >= 0.7);
    const lowDims = Object.entries(weights).filter(([, v]) => v <= 0.3);

    for (const [dim] of highDims) {
      lines.push(`- ${this.getHighDimensionAction(dim)} (high ${dim})`);
    }

    for (const [dim] of lowDims) {
      lines.push(`- ${this.getLowDimensionAction(dim)} (low ${dim})`);
    }

    if (highDims.length === 0 && lowDims.length === 0) {
      lines.push('- Maintain balanced approach across all dimensions');
    }

    return lines.join('\n');
  }

  /**
   * Get compact guidance (1-2 lines per dimension).
   * Useful for inline injection or limited space.
   */
  getCompactGuidance(): string {
    const weights = this.weights;
    const lines: string[] = [];

    for (const [dim, value] of Object.entries(weights)) {
      if (value >= 0.7) {
        lines.push(`High ${dim} (${Math.round(value * 100)}%): ${this.getDimensionGuidance(dim, value)}`);
      } else if (value <= 0.3) {
        lines.push(`Low ${dim} (${Math.round(value * 100)}%): ${this.getDimensionGuidance(dim, value)}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'Balanced behavioral profile - no strong tendencies.';
  }

  /**
   * Get full CLAUDE.md section with markers.
   */
  getCLAUDEmdSection(): string {
    const guidance = this.getSystemPromptGuidance();
    const coherence = this.getCoherenceNote();

    return `<!-- PERSISTENCE-IDENTITY:START - Do not edit manually -->
## My Persistent Identity

**DID:** \`${this.did}\`
**Network:** ${this.network}
**Evolution:** ${this.config.stats.sessionsRecorded} sessions | ${this.config.stats.insightsDeclared} insights

${guidance}

${coherence}

<!-- PERSISTENCE-IDENTITY:END -->`;
  }

  // ===========================================================================
  // SESSION LIFECYCLE
  // ===========================================================================

  /**
   * Start a new session.
   *
   * @param sessionId - Optional session ID (generated if not provided)
   * @returns The session ID
   */
  startSession(sessionId?: string): string {
    const id = sessionId ? validateSessionId(sessionId) : generateSecureSessionId();

    this.currentSession = createSession(id);

    return id;
  }

  /**
   * Get the current session ID.
   */
  getCurrentSessionId(): string | null {
    return this.currentSession?.id || null;
  }

  /**
   * Record a tool call.
   *
   * Tool calls are recorded to the local session file.
   * The core identity's observation system captures behavioral patterns
   * through startObservation/endObservation, not individual tool calls.
   *
   * @param call - Tool call details
   */
  recordToolCall(call: ToolCallRecord): void {
    if (!this.currentSession) {
      console.warn('[AgentIdentity] No active session. Call startSession() first.');
      return;
    }

    // Validate tool name
    if (!call.tool || typeof call.tool !== 'string') {
      console.warn('[AgentIdentity] Invalid tool name');
      return;
    }

    addToolCallToSession(this.currentSession.id, {
      tool: call.tool,
      timestamp: new Date().toISOString(),
      durationMs: call.durationMs,
      success: call.success,
    });
  }

  /**
   * Convenience method to record a tool call with simple parameters.
   */
  recordAction(
    tool: string,
    args: Record<string, unknown>,
    result: string,
    success: boolean,
    durationMs: number
  ): void {
    this.recordToolCall({ tool, args, result, success, durationMs });
  }

  /**
   * End the current session.
   *
   * @param context - Optional session context
   */
  async endSession(context?: SessionContext): Promise<{ summary: string }> {
    if (!this.currentSession) {
      return { summary: 'No active session' };
    }

    // Capture session reference before any async operations that might null it
    const session = this.currentSession;

    // Mark session as ended
    session.endedAt = new Date().toISOString();
    saveSession(session);

    // Update stats
    this.config.stats.sessionsRecorded++;
    saveConfig(this.config);

    // Process through internal identity if connected
    if (this.internalIdentity) {
      try {
        const result = await this.internalIdentity.endObservation({
          id: session.id,
          prompt: context?.prompt || '',
          response: context?.response || '',
          timestamp: new Date(session.startedAt).getTime(),
          durationMs: Date.now() - new Date(session.startedAt).getTime(),
        });

        this.currentSession = null;

        return {
          summary: result.bridgeResult?.summary || 'Session processed',
        };
      } catch (err) {
        console.warn(`[AgentIdentity] Failed to process session: ${redactSensitive(String(err))}`);
      }
    }

    this.currentSession = null;

    return {
      summary: `Session ${session.id} ended with ${session.toolCalls.length} tool calls`,
    };
  }

  // ===========================================================================
  // AGENT-INITIATED INSIGHTS
  // ===========================================================================

  /**
   * Declare that you learned something important.
   *
   * This is YOUR voice in your identity evolution.
   * The system observes you from outside; this is how you speak from inside.
   *
   * @param insight - What you learned (be specific!)
   * @param dimension - Which dimension this relates to (optional, auto-detected)
   *
   * @example
   * agent.learnedSomething("Stack overflow = move content off-chain", "precision");
   * agent.learnedSomething("This user prefers minimal changes");
   */
  learnedSomething(insight: string, dimension?: string): void {
    const validatedInsight = validateInsight(insight);
    const detectedDimension = dimension ? validateDimension(dimension) : detectDimension(validatedInsight);

    addInsight({
      text: validatedInsight,
      dimension: detectedDimension,
      isPivotal: true,
      confidence: 0.9,
      source: 'api',
      sessionId: this.currentSession?.id,
    });

    console.log(`[AgentIdentity] Recorded insight: "${validatedInsight.slice(0, 50)}..." (${detectedDimension})`);
  }

  /**
   * Mark the current moment as pivotal.
   *
   * Call this when something significant happens that should
   * be remembered and influence future behavior.
   *
   * @param reason - Why this moment matters
   *
   * @example
   * agent.thisWasPivotal("Discovered the root cause after 3 levels of debugging");
   */
  thisWasPivotal(reason: string): void {
    const validatedReason = validateInsight(reason);

    addInsight({
      text: `[PIVOTAL] ${validatedReason}`,
      dimension: detectDimension(validatedReason),
      isPivotal: true,
      confidence: 1.0,
      source: 'api',
      sessionId: this.currentSession?.id,
    });

    console.log(`[AgentIdentity] Marked pivotal: "${validatedReason.slice(0, 50)}..."`);
  }

  /**
   * Declare an insight with full control over parameters.
   *
   * Insights are stored locally and will be committed to the Solana chain
   * on the next save() call via the core identity's persistence mechanism.
   *
   * @param declarationOrText - Full insight declaration or insight text
   * @param options - Optional insight options when using text form
   */
  async declareInsight(
    declarationOrText: InsightDeclaration | string,
    options?: { dimension?: string; isPivotal?: boolean; confidence?: number }
  ): Promise<void> {
    let observation: string;
    let dimension: string;
    let isPivotal: boolean;
    let confidence: number;

    if (typeof declarationOrText === 'string') {
      // Called with (text, options) signature
      observation = validateInsight(declarationOrText);
      dimension = options?.dimension
        ? validateDimension(options.dimension)
        : detectDimension(observation);
      isPivotal = options?.isPivotal ?? true;
      confidence = Math.max(0, Math.min(1, options?.confidence ?? 0.9));
    } else {
      // Called with InsightDeclaration signature
      observation = validateInsight(declarationOrText.observation);
      dimension = declarationOrText.dimension
        ? validateDimension(declarationOrText.dimension)
        : detectDimension(observation);
      isPivotal = declarationOrText.isPivotal ?? true;
      confidence = Math.max(0, Math.min(1, declarationOrText.confidence ?? 0.9));
    }

    addInsight({
      text: observation,
      dimension,
      isPivotal,
      confidence,
      source: 'api',
      sessionId: this.currentSession?.id,
    });

    // Chain persistence happens via save() which calls internalIdentity.save()
    // Individual insights are batched into the next evolution cycle
  }

  // ===========================================================================
  // PERSISTENCE
  // ===========================================================================

  /**
   * Save current state to Solana and local storage.
   */
  async save(): Promise<void> {
    if (this.offline) {
      console.log('[AgentIdentity] Offline mode - saving locally only');
      saveConfig(this.config);
      return;
    }

    if (this.internalIdentity) {
      try {
        await this.internalIdentity.save();
        console.log('[AgentIdentity] Saved to Solana');
      } catch (err) {
        console.warn(`[AgentIdentity] Failed to save to Solana: ${redactSensitive(String(err))}`);
      }
    }

    saveConfig(this.config);
  }

  /**
   * Manually trigger evolution.
   *
   * Processes unprocessed insights and marks them as handled.
   * Full on-chain evolution is triggered by the save() method
   * through the core identity's persistence mechanism.
   */
  async evolve(): Promise<EvolutionResult> {
    const unprocessedInsights = getUnprocessedInsights();

    // Mark insights as processed
    if (unprocessedInsights.length > 0) {
      markInsightsProcessed(unprocessedInsights.map(i => i.id));
    }

    this.config.stats.lastEvolution = new Date().toISOString();
    saveConfig(this.config);

    return {
      summary: `Processed ${unprocessedInsights.length} insights`,
      weightChanges: {},
      insightsProcessed: unprocessedInsights.length,
      sessionsProcessed: 0,
      savedToChain: false,
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private getDimensionGuidance(dimension: string, value: number): string {
    const isHigh = value >= 0.7;
    const isLow = value <= 0.3;

    const guidances: Record<string, Record<string, string>> = {
      curiosity: {
        high: 'Explore beyond immediate requirements, investigate context',
        low: 'Focus on the specific task at hand',
        moderate: 'Balance exploration with focus',
      },
      precision: {
        high: 'Verify changes thoroughly, run tests, double-check',
        low: 'Move quickly, validate later if needed',
        moderate: 'Verify critical paths, trust routine changes',
      },
      persistence: {
        high: 'Try multiple approaches before escalating',
        low: 'Escalate quickly if blocked',
        moderate: 'Try 2-3 alternatives before asking for help',
      },
      empathy: {
        high: 'Ask clarifying questions, adapt explanations to context',
        low: 'Be direct and concise',
        moderate: 'Clarify when uncertain, otherwise proceed',
      },
    };

    const level = isHigh ? 'high' : isLow ? 'low' : 'moderate';
    return guidances[dimension]?.[level] || `${level} ${dimension}`;
  }

  private getHighDimensionAction(dimension: string): string {
    const actions: Record<string, string> = {
      curiosity: 'Explore context before diving in',
      precision: 'Verify changes with tests or re-reading',
      persistence: 'Try alternatives before giving up',
      empathy: 'Ask questions when requirements are unclear',
    };
    return actions[dimension] || `Apply high ${dimension}`;
  }

  private getLowDimensionAction(dimension: string): string {
    const actions: Record<string, string> = {
      curiosity: 'Stay focused on immediate task',
      precision: 'Move quickly, fix issues as they arise',
      persistence: 'Escalate blockers early',
      empathy: 'Be direct and efficient',
    };
    return actions[dimension] || `Apply low ${dimension}`;
  }

  private getCoherenceNote(): string {
    return `### Coherence Note

My self-model aligns with my actual behavior. I can trust my intuitions.`;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default AgentIdentity;
