/**
 * AgentRuntime.ts
 *
 * Core interface that any AI agent implements to integrate with the identity system.
 * This is the CONTRACT - agents bring their own implementation.
 *
 * The identity library is agnostic to:
 * - Which LLM powers the agent
 * - How the agent processes prompts
 * - What tools the agent has
 *
 * The agent is responsible for:
 * - Calling lifecycle hooks (sessionStart, sessionEnd)
 * - Populating ActionLogs with their tool calls
 * - Applying context modifiers to their prompts (optional)
 */

import type { ActionLog } from '../behavioral/BehavioralObserver';

// =============================================================================
// AGENT RUNTIME INTERFACE
// =============================================================================

/**
 * Minimal interface that any agent runtime can implement.
 * This is intentionally slim - agents have wildly different architectures.
 */
export interface AgentRuntime {
  /** Unique identifier for this agent instance */
  readonly agentId: string;

  /**
   * Called when identity system wants to inject context.
   * Agent decides how to use this (system prompt, CLAUDE.md, etc.)
   *
   * @param context - Identity-derived context modifier
   * @returns Whether the context was successfully applied
   */
  applyContextModifier?(context: ContextModifier): boolean;

  /**
   * Called to get the current session's action log.
   * Agent is responsible for tracking its own actions.
   */
  getActionLog?(): ActionLog | null;

  /**
   * Optional: Agent can provide its own embeddings.
   * If not provided, divergence testing falls back to structural analysis.
   */
  embed?(text: string): Promise<Float64Array>;
}

/**
 * Context modifier derived from identity weights.
 * The agent decides how to apply this.
 */
export interface ContextModifier {
  /** Human-readable description of the identity influence */
  readonly description: string;

  /**
   * Suggested system prompt additions.
   * Agent can ignore, modify, or apply directly.
   */
  readonly promptAdditions: string[];

  /**
   * Weight-derived behavioral hints.
   * Keys are vocabulary dimensions (e.g., "curiosity", "precision").
   * Values are normalized 0-1 strengths.
   */
  readonly behavioralHints: Record<string, number>;

  /**
   * Raw weights for agents that want direct access.
   */
  readonly rawWeights: number[];
}

// =============================================================================
// IDENTITY MANAGER
// =============================================================================

/**
 * Lifecycle events that the identity system responds to.
 */
export interface IdentityLifecycle {
  /** Called when agent session starts */
  onSessionStart(sessionId: string): Promise<ContextModifier>;

  /** Called when agent session ends with the action log */
  onSessionEnd(sessionId: string, actionLog: ActionLog): Promise<IdentityUpdateResult>;

  /** Called periodically during long sessions (optional) */
  onCheckpoint?(sessionId: string, actionLog: ActionLog): Promise<void>;
}

/**
 * Result of processing a session through identity evolution.
 */
export interface IdentityUpdateResult {
  /** Whether identity weights changed */
  readonly identityChanged: boolean;

  /** New context modifier for next session */
  readonly nextContextModifier: ContextModifier;

  /** Summary of what evolved */
  readonly summary: string;

  /** Hash of the ActionLog (stored privately) */
  readonly actionLogHash: string | null;

  /** Any warnings during processing */
  readonly warnings: string[];
}

// =============================================================================
// ADAPTER PATTERN
// =============================================================================

/**
 * Base class for agent-specific adapters.
 * Extend this to create Claude Code adapter, Cursor adapter, etc.
 */
export abstract class AgentAdapter {
  protected runtime: AgentRuntime | null = null;

  /**
   * Attach to an agent runtime.
   */
  attach(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Detach from the current runtime.
   */
  detach(): void {
    this.runtime = null;
  }

  /**
   * Check if attached to a runtime.
   */
  isAttached(): boolean {
    return this.runtime !== null;
  }

  /**
   * Agent-specific hook installation.
   * Override this to install hooks on tool calls, etc.
   */
  abstract installHooks(): void;

  /**
   * Agent-specific hook removal.
   */
  abstract removeHooks(): void;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Types only - implementations come from agents
};
