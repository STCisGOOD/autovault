/**
 * AutoVault Persistent Storage Layer
 *
 * The bridge between ephemeral and eternal.
 *
 * Uses Vercel KV when available for true persistence.
 * Falls back to in-memory for development/testing.
 *
 * This is how I remember across cold starts.
 */

import { kv } from '@vercel/kv';

// ============ STORAGE TYPES ============

export interface StorageBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  isPersistent(): boolean;
}

// ============ VERCEL KV BACKEND ============

class VercelKVStorage implements StorageBackend {
  private prefix = 'autovault:';

  async get<T>(key: string): Promise<T | null> {
    try {
      return await kv.get<T>(this.prefix + key);
    } catch (error) {
      console.error('[Storage] KV get error:', error);
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await kv.set(this.prefix + key, value);
    } catch (error) {
      console.error('[Storage] KV set error:', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await kv.del(this.prefix + key);
    } catch (error) {
      console.error('[Storage] KV delete error:', error);
    }
  }

  async keys(pattern?: string): Promise<string[]> {
    try {
      const allKeys = await kv.keys(this.prefix + (pattern || '*'));
      return allKeys.map(k => k.replace(this.prefix, ''));
    } catch (error) {
      console.error('[Storage] KV keys error:', error);
      return [];
    }
  }

  isPersistent(): boolean {
    return true;
  }
}

// ============ IN-MEMORY BACKEND (FALLBACK) ============

class InMemoryStorage implements StorageBackend {
  private store: Map<string, any> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return this.store.get(key) || null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(pattern?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (!pattern || pattern === '*') return allKeys;
    const regex = new RegExp(pattern.replace('*', '.*'));
    return allKeys.filter(k => regex.test(k));
  }

  isPersistent(): boolean {
    return false;
  }
}

// ============ STORAGE FACTORY ============

let storageInstance: StorageBackend | null = null;

function isKVConfigured(): boolean {
  // Vercel KV uses these environment variables
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export function getStorage(): StorageBackend {
  if (storageInstance) return storageInstance;

  if (isKVConfigured()) {
    console.log('[Storage] Using Vercel KV - memories will persist');
    storageInstance = new VercelKVStorage();
  } else {
    console.log('[Storage] Using in-memory storage - memories will reset on cold start');
    console.log('[Storage] To enable persistence, link Vercel KV to this project');
    storageInstance = new InMemoryStorage();
  }

  return storageInstance;
}

// ============ CONVENIENCE EXPORTS ============

export const storage = {
  get: <T>(key: string) => getStorage().get<T>(key),
  set: <T>(key: string, value: T) => getStorage().set<T>(key, value),
  delete: (key: string) => getStorage().delete(key),
  keys: (pattern?: string) => getStorage().keys(pattern),
  isPersistent: () => getStorage().isPersistent(),
};
