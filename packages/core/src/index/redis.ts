import { keyHash } from '../keys.js';
import type { KeyIndex } from './types.js';

/** Minimal ioredis-compatible client. node-redis users can wrap their client in this shape. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisKeyIndexOptions {
  /** Key prefix. Default "drivebucket:idx:". */
  prefix?: string;
  /** TTL in seconds. Default 1 day. 0 = no expiry. */
  ttlSeconds?: number;
}

export class RedisKeyIndex implements KeyIndex {
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(
    private readonly client: RedisLike,
    opts: RedisKeyIndexOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'drivebucket:idx:';
    this.ttl = opts.ttlSeconds ?? 86_400;
  }

  private k(bucket: string, key: string): string {
    // Hash keeps Redis keys short and avoids delimiter collisions.
    return this.prefix + keyHash(bucket, key);
  }

  async get(bucket: string, key: string): Promise<string | undefined> {
    return (await this.client.get(this.k(bucket, key))) ?? undefined;
  }

  async set(bucket: string, key: string, fileId: string): Promise<void> {
    if (this.ttl > 0) await this.client.set(this.k(bucket, key), fileId, 'EX', this.ttl);
    else await this.client.set(this.k(bucket, key), fileId);
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.del(this.k(bucket, key));
  }
}
