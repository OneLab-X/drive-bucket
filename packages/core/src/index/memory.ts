import type { KeyIndex } from './types.js';

export interface MemoryLRUIndexOptions {
  /** Max entries kept. Default 10,000. */
  maxEntries?: number;
  /** Entry lifetime in ms. Default 1 hour. 0 = no expiry. */
  ttlMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

/** In-process LRU. Default index; fine for a single process. */
export class MemoryLRUIndex implements KeyIndex {
  private readonly map = new Map<string, { id: string; expires: number }>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: MemoryLRUIndexOptions = {}) {
    this.max = opts.maxEntries ?? 10_000;
    this.ttl = opts.ttlMs ?? 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private k(bucket: string, key: string): string {
    return `${bucket}\0${key}`;
  }

  get size(): number {
    return this.map.size;
  }

  async get(bucket: string, key: string): Promise<string | undefined> {
    const k = this.k(bucket, key);
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (this.ttl > 0 && hit.expires <= this.now()) {
      this.map.delete(k);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(k);
    this.map.set(k, hit);
    return hit.id;
  }

  async set(bucket: string, key: string, fileId: string): Promise<void> {
    const k = this.k(bucket, key);
    this.map.delete(k);
    this.map.set(k, { id: fileId, expires: this.ttl > 0 ? this.now() + this.ttl : Infinity });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.map.delete(this.k(bucket, key));
  }
}
