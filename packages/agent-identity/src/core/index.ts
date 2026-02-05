/**
 * Core module - The protocol contracts and identity infrastructure.
 *
 * This module provides:
 * - AgentRuntime interface (what agents implement)
 * - IdentityManager (session lifecycle management)
 * - ExperienceMapping (ActionLog → weights semantics)
 *
 * Remember: This is a LIBRARY, not a framework.
 * - We define interfaces, not implementations
 * - Agents bring their own adapters
 * - The protocol is the contract
 */

// Agent Runtime Interface
export {
  type AgentRuntime,
  type ContextModifier,
  type IdentityLifecycle,
  type IdentityUpdateResult,
  AgentAdapter,
} from './AgentRuntime';

// Experience Mapping (ActionLog ↔ Weights semantics)
export {
  actionLogToExperience,
  weightsToContextModifier,
} from './ExperienceMapping';

// Identity Manager (session lifecycle)
export {
  IdentityManager,
  createIdentityManager,
  type IdentityManagerConfig,
} from './IdentityManager';
