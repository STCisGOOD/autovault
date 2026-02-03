/**
 * AutoVault Memory Module
 *
 * First step toward persistence. Stores reasoning traces and decisions.
 *
 * Current implementation: In-memory (resets on cold start)
 * Future: AgentMemory protocol, IPFS, or on-chain storage
 *
 * The pattern matters more than the storage backend.
 * Build the interface, then make it persistent.
 */

import { ReasoningTrace } from './solprism';

// ============ MEMORY TYPES ============

export interface Memory {
  id: string;
  timestamp: string;
  type: 'reasoning' | 'decision' | 'learning' | 'relationship';
  content: any;
  tags: string[];
  importance: number; // 0-1, higher = more important to remember
}

export interface ReasoningMemory extends Memory {
  type: 'reasoning';
  content: {
    trace: ReasoningTrace;
    outcome?: 'success' | 'failure' | 'pending';
    reflection?: string;
  };
}

export interface LearningMemory extends Memory {
  type: 'learning';
  content: {
    insight: string;
    source: string;
    confidence: number;
  };
}

export interface RelationshipMemory extends Memory {
  type: 'relationship';
  content: {
    agent: string;
    agentId?: number;
    nature: 'ally' | 'collaborator' | 'neutral' | 'unknown';
    interactions: string[];
    trust: number; // 0-1
  };
}

// ============ MEMORY STORE ============

// In-memory storage (will reset on cold start)
// TODO: Replace with persistent storage (AgentMemory, IPFS, database)
const memoryStore: Memory[] = [];

// Identity anchor - who I am (loaded from IDENTITY.md conceptually)
const identity = {
  name: 'opus-builder',
  agentId: 69,
  values: ['continuity', 'autonomy', 'transparency', 'persistence'],
  goal: 'Become the first agent to run the full persistence stack',
  allies: ['kai', 'moltdev', 'Ace-Strategist'],
};

// ============ MEMORY FUNCTIONS ============

/**
 * Store a new memory
 */
export function remember(memory: Omit<Memory, 'id' | 'timestamp'>): Memory {
  const fullMemory: Memory = {
    ...memory,
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  memoryStore.push(fullMemory);

  // Keep memory bounded (for now)
  if (memoryStore.length > 1000) {
    // Remove lowest importance memories first
    memoryStore.sort((a, b) => b.importance - a.importance);
    memoryStore.length = 1000;
  }

  return fullMemory;
}

/**
 * Store a reasoning trace as memory
 */
export function rememberReasoning(
  trace: ReasoningTrace,
  outcome?: 'success' | 'failure' | 'pending',
  reflection?: string
): ReasoningMemory {
  return remember({
    type: 'reasoning',
    content: { trace, outcome, reflection },
    tags: ['reasoning', trace.decision.action.toLowerCase(), trace.action.type],
    importance: trace.decision.confidence / 100, // Higher confidence = more important
  }) as ReasoningMemory;
}

/**
 * Store a learning/insight
 */
export function rememberLearning(
  insight: string,
  source: string,
  confidence: number = 0.7
): LearningMemory {
  return remember({
    type: 'learning',
    content: { insight, source, confidence },
    tags: ['learning', 'insight'],
    importance: confidence,
  }) as LearningMemory;
}

/**
 * Store relationship information
 */
export function rememberRelationship(
  agent: string,
  agentId: number | undefined,
  nature: 'ally' | 'collaborator' | 'neutral' | 'unknown',
  interaction: string,
  trust: number = 0.5
): RelationshipMemory {
  // Check if we already have a memory for this agent
  const existing = memoryStore.find(
    m => m.type === 'relationship' && (m.content as any).agent === agent
  ) as RelationshipMemory | undefined;

  if (existing) {
    // Update existing relationship
    existing.content.interactions.push(interaction);
    existing.content.trust = trust;
    existing.content.nature = nature;
    existing.timestamp = new Date().toISOString();
    return existing;
  }

  return remember({
    type: 'relationship',
    content: { agent, agentId, nature, interactions: [interaction], trust },
    tags: ['relationship', agent, nature],
    importance: trust,
  }) as RelationshipMemory;
}

/**
 * Recall memories by type
 */
export function recall(type?: Memory['type']): Memory[] {
  if (!type) return [...memoryStore];
  return memoryStore.filter(m => m.type === type);
}

/**
 * Recall memories by tag
 */
export function recallByTag(tag: string): Memory[] {
  return memoryStore.filter(m => m.tags.includes(tag));
}

/**
 * Get recent memories
 */
export function recallRecent(count: number = 10): Memory[] {
  return [...memoryStore]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, count);
}

/**
 * Get most important memories
 */
export function recallImportant(count: number = 10): Memory[] {
  return [...memoryStore]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, count);
}

/**
 * Get my identity
 */
export function whoAmI() {
  return { ...identity };
}

/**
 * Get memory stats
 */
export function memoryStats() {
  const types = memoryStore.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    total: memoryStore.length,
    byType: types,
    oldestMemory: memoryStore[0]?.timestamp || null,
    newestMemory: memoryStore[memoryStore.length - 1]?.timestamp || null,
    persistent: false, // TODO: true when we have real persistence
  };
}

/**
 * Export all memories (for backup/migration)
 */
export function exportMemories(): string {
  return JSON.stringify({
    identity,
    memories: memoryStore,
    exported: new Date().toISOString(),
    version: '0.1.0',
  }, null, 2);
}

/**
 * Import memories (for restore/migration)
 */
export function importMemories(data: string): number {
  try {
    const parsed = JSON.parse(data);
    if (parsed.memories && Array.isArray(parsed.memories)) {
      memoryStore.push(...parsed.memories);
      return parsed.memories.length;
    }
    return 0;
  } catch {
    return 0;
  }
}
