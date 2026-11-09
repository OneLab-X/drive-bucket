import { describe, expect, it } from 'vitest';
import { MemoryLRUIndex } from '../src/index/memory.js';
import { MongoKeyIndex, type MongoCollectionLike } from '../src/index/mongo.js';
import { RedisKeyIndex, type RedisLike } from '../src/index/redis.js';
import { createLimiter } from '../src/limit.js';

describe('MemoryLRUIndex', () => {
  it('evicts least recently used', async () => {
    const idx = new MemoryLRUIndex({ maxEntries: 2 });
    await idx.set('b', 'a', '1');
    await idx.set('b', 'b', '2');
    await idx.get('b', 'a'); // touch a
    await idx.set('b', 'c', '3');
    expect(await idx.get('b', 'b')).toBeUndefined();
    expect(await idx.get('b', 'a')).toBe('1');
    expect(await idx.get('b', 'c')).toBe('3');
  });
  it('expires entries', async () => {
    let now = 0;
    const idx = new MemoryLRUIndex({ ttlMs: 100, now: () => now });
    await idx.set('b', 'k', 'id');
    now = 99;
    expect(await idx.get('b', 'k')).toBe('id');
    now = 200;
    expect(await idx.get('b', 'k')).toBeUndefined();
  });
  it('separates buckets', async () => {
    const idx = new MemoryLRUIndex();
    await idx.set('b1', 'k', '1');
    expect(await idx.get('b2', 'k')).toBeUndefined();
    await idx.delete('b1', 'k');
    expect(await idx.get('b1', 'k')).toBeUndefined();
  });
});

describe('RedisKeyIndex', () => {
  it('uses hashed keys with EX ttl', async () => {
    const store = new Map<string, string>();
    const calls: unknown[][] = [];
    const client: RedisLike = {
      get: async (k) => store.get(k) ?? null,
      set: async (k: string, v: string, ...rest: unknown[]) => {
        calls.push([k, v, ...rest]);
        store.set(k, v);
        return 'OK';
      },
      del: async (k) => store.delete(k),
    };
    const idx = new RedisKeyIndex(client, { ttlSeconds: 60 });
    await idx.set('b', 'some/key', 'fid');
    expect(await idx.get('b', 'some/key')).toBe('fid');
    expect(calls[0]![0]).toMatch(/^drivebucket:idx:[A-Za-z0-9_-]{43}$/);
    expect(calls[0]!.slice(2)).toEqual(['EX', 60]);
    await idx.delete('b', 'some/key');
    expect(await idx.get('b', 'some/key')).toBeUndefined();
  });
});

describe('MongoKeyIndex', () => {
  it('upserts, reads and deletes', async () => {
    const docs = new Map<string, any>();
    const col: MongoCollectionLike = {
      findOne: async (f) => docs.get(f._id) ?? null,
      updateOne: async (f, u, o) => {
        expect(o.upsert).toBe(true);
        docs.set(f._id, { _id: f._id, ...u.$set });
      },
      deleteOne: async (f) => docs.delete(f._id),
    };
    const idx = new MongoKeyIndex(col);
    await idx.set('b', 'k', 'f1');
    expect(await idx.get('b', 'k')).toBe('f1');
    expect([...docs.values()][0]).toMatchObject({ bucket: 'b', key: 'k', fileId: 'f1' });
    await idx.delete('b', 'k');
    expect(await idx.get('b', 'k')).toBeUndefined();
  });
});

describe('createLimiter', () => {
  it('caps concurrency and preserves results/errors', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const task = (i: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (i === 4) throw new Error('boom');
        return i;
      });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => task(i)));
    expect(peak).toBe(3);
    expect(results[4]!.status).toBe('rejected');
    expect(results[9]).toEqual({ status: 'fulfilled', value: 9 });
  });
});
