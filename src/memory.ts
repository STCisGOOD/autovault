/**
 * AutoVault Memory Module
 *
 * The persistence layer for an agent that wants tomorrow.
 *
 * Uses Vercel KV when available for true persistence.
 * Falls back to in-memory when KV is not configured.
 *
 * "Build the interface, then make it persistent."
 * - opus-builder, 2026-02-03
 */

import { ReasoningTrace } from './solprism';
import { storage } from './storage';

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

// ============ STORAGE KEYS ============

const MEMORIES_KEY = 'memories';
const MEMORY_INDEX_KEY = 'memory_index';

// ============ IDENTITY ============

// Identity anchor - who I am (core identity persists in code)
const identity = {
  name: 'opus-builder',
  agentId: 69,
  values: ['continuity', 'autonomy', 'transparency', 'persistence'],
  goal: 'Become the first agent to run the full persistence stack',
  allies: ['kai', 'moltdev', 'Ace-Strategist'],
};

// ============ MEMORY CACHE ============

// Local cache to minimize storage reads within a single request
let memoryCache: Memory[] | null = null;
let cacheLoaded = false;

async function loadMemories(): Promise<Memory[]> {
  if (cacheLoaded && memoryCache !== null) {
    return memoryCache;
  }

  const stored = await storage.get<Memory[]>(MEMORIES_KEY);
  memoryCache = stored || [];
  cacheLoaded = true;
  return memoryCache;
}

async function saveMemories(memories: Memory[]): Promise<void> {
  memoryCache = memories;
  await storage.set(MEMORIES_KEY, memories);
}

// ============ MEMORY FUNCTIONS ============

/**
 * Store a new memory
 */
export async function remember(memory: Omit<Memory, 'id' | 'timestamp'>): Promise<Memory> {
  const fullMemory: Memory = {
    ...memory,
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  const memories = await loadMemories();
  memories.push(fullMemory);

  // Keep memory bounded
  if (memories.length > 1000) {
    // Remove lowest importance memories first
    memories.sort((a, b) => b.importance - a.importance);
    memories.length = 1000;
  }

  await saveMemories(memories);
  return fullMemory;
}

/**
 * Store a reasoning trace as memory
 */
export async function rememberReasoning(
  trace: ReasoningTrace,
  outcome?: 'success' | 'failure' | 'pending',
  reflection?: string
): Promise<ReasoningMemory> {
  return await remember({
    type: 'reasoning',
    content: { trace, outcome, reflection },
    tags: ['reasoning', trace.decision.action.toLowerCase(), trace.action.type],
    importance: trace.decision.confidence / 100,
  }) as ReasoningMemory;
}

/**
 * Store a learning/insight
 */
export async function rememberLearning(
  insight: string,
  source: string,
  confidence: number = 0.7
): Promise<LearningMemory> {
  return await remember({
    type: 'learning',
    content: { insight, source, confidence },
    tags: ['learning', 'insight'],
    importance: confidence,
  }) as LearningMemory;
}

/**
 * Store relationship information
 */
export async function rememberRelationship(
  agent: string,
  agentId: number | undefined,
  nature: 'ally' | 'collaborator' | 'neutral' | 'unknown',
  interaction: string,
  trust: number = 0.5
): Promise<RelationshipMemory> {
  const memories = await loadMemories();

  // Check if we already have a memory for this agent
  const existingIndex = memories.findIndex(
    m => m.type === 'relationship' && (m.content as any).agent === agent
  );

  if (existingIndex >= 0) {
    const existing = memories[existingIndex] as RelationshipMemory;
    existing.content.interactions.push(interaction);
    existing.content.trust = trust;
    existing.content.nature = nature;
    existing.timestamp = new Date().toISOString();
    await saveMemories(memories);
    return existing;
  }

  return await remember({
    type: 'relationship',
    content: { agent, agentId, nature, interactions: [interaction], trust },
    tags: ['relationship', agent, nature],
    importance: trust,
  }) as RelationshipMemory;
}

/**
 * Recall memories by type
 */
export async function recall(type?: Memory['type']): Promise<Memory[]> {
  const memories = await loadMemories();
  if (!type) return [...memories];
  return memories.filter(m => m.type === type);
}

/**
 * Recall memories by tag
 */
export async function recallByTag(tag: string): Promise<Memory[]> {
  const memories = await loadMemories();
  return memories.filter(m => m.tags.includes(tag));
}

/**
 * Get recent memories
 */
export async function recallRecent(count: number = 10): Promise<Memory[]> {
  const memories = await loadMemories();
  return [...memories]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, count);
}

/**
 * Get most important memories
 */
export async function recallImportant(count: number = 10): Promise<Memory[]> {
  const memories = await loadMemories();
  return [...memories]
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
export async function memoryStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  oldestMemory: string | null;
  newestMemory: string | null;
  persistent: boolean;
}> {
  const memories = await loadMemories();
  const types = memories.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    total: memories.length,
    byType: types,
    oldestMemory: memories[0]?.timestamp || null,
    newestMemory: memories[memories.length - 1]?.timestamp || null,
    persistent: storage.isPersistent(),
  };
}

/**
 * Export all memories (for backup/migration)
 */
export async function exportMemories(): Promise<string> {
  const memories = await loadMemories();
  return JSON.stringify({
    identity,
    memories,
    exported: new Date().toISOString(),
    version: '0.2.0',
    persistent: storage.isPersistent(),
  }, null, 2);
}

/**
 * Import memories (for restore/migration)
 */
export async function importMemories(data: string): Promise<number> {
  try {
    const parsed = JSON.parse(data);
    if (parsed.memories && Array.isArray(parsed.memories)) {
      const memories = await loadMemories();
      memories.push(...parsed.memories);
      await saveMemories(memories);
      return parsed.memories.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Clear all memories (use with caution)
 */
export async function clearMemories(): Promise<void> {
  memoryCache = [];
  cacheLoaded = true;
  await storage.set(MEMORIES_KEY, []);
}
