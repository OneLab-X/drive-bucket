import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CachedVariant {
  body: Buffer;
  contentType: string;
}

/** Storage for resized image variants. Keys are hex SHA-256 strings. */
export interface ResizeCache {
  get(key: string): Promise<CachedVariant | undefined>;
  set(key: string, value: CachedVariant): Promise<void>;
}

/** Simple in-process LRU bounded by total bytes. */
export class MemoryResizeCache implements ResizeCache {
  private readonly map = new Map<string, CachedVariant>();
  private bytes = 0;
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  async get(key: string): Promise<CachedVariant | undefined> {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  async set(key: string, value: CachedVariant): Promise<void> {
    if (value.body.length > this.maxBytes) return;
    const prev = this.map.get(key);
    if (prev) this.bytes -= prev.body.length;
    this.map.delete(key);
    this.map.set(key, value);
    this.bytes += value.body.length;
    while (this.bytes > this.maxBytes) {
      const [k, v] = this.map.entries().next().value as [string, CachedVariant];
      this.map.delete(k);
      this.bytes -= v.body.length;
    }
  }
}

function encode(v: CachedVariant): Buffer {
  const ct = Buffer.from(v.contentType, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(ct.length);
  return Buffer.concat([head, ct, v.body]);
}

function decode(buf: Buffer): CachedVariant | undefined {
  if (buf.length < 2) return undefined;
  const n = buf.readUInt16BE(0);
  if (buf.length < 2 + n) return undefined;
  return { contentType: buf.subarray(2, 2 + n).toString('utf8'), body: buf.subarray(2 + n) };
}

const KEY_RE = /^[a-f0-9]{16,128}$/;

export interface DiskResizeCacheOptions {
  dir: string;
  /** Evict least-recently-used files beyond this size. Default 1 GiB. */
  maxBytes?: number;
}

/**
 * Disk cache: one file per variant under `dir/<2-char shard>/<key>`. Writes are atomic
 * (temp file + rename). Recency is tracked via mtime, bumped on read.
 */
export class DiskResizeCache implements ResizeCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private entries: Map<string, { size: number; atime: number }> | undefined;
  private loading: Promise<void> | undefined;
  private bytes = 0;
  private evicting = false;

  constructor(opts: DiskResizeCacheOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
  }

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('invalid cache key');
    return join(this.dir, key.slice(0, 2), key);
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const entries = new Map<string, { size: number; atime: number }>();
      await mkdir(this.dir, { recursive: true });
      for (const shard of await readdir(this.dir)) {
        let files: string[] = [];
        try {
          files = await readdir(join(this.dir, shard));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!KEY_RE.test(f)) continue;
          const st = await stat(join(this.dir, shard, f)).catch(() => undefined);
          if (st?.isFile()) {
            entries.set(f, { size: st.size, atime: st.mtimeMs });
            this.bytes += st.size;
          }
        }
      }
      this.entries = entries;
    })();
    return this.loading;
  }

  /** Current tracked size in bytes (for tests/metrics). */
  async size(): Promise<number> {
    await this.load();
    return this.bytes;
  }

  async get(key: string): Promise<CachedVariant | undefined> {
    await this.load();
    const p = this.path(key);
    let buf: Buffer;
    try {
      buf = await readFile(p);
    } catch {
      return undefined;
    }
    const now = Date.now();
    const e = this.entries!.get(key);
    if (e) e.atime = now;
    utimes(p, now / 1000, now / 1000).catch(() => undefined);
    return decode(buf);
  }

  async set(key: string, value: CachedVariant): Promise<void> {
    await this.load();
    const p = this.path(key);
    const data = encode(value);
    if (data.length > this.maxBytes) return;
    await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
    const prev = this.entries!.get(key);
    if (prev) this.bytes -= prev.size;
    this.entries!.set(key, { size: data.length, atime: Date.now() });
    this.bytes += data.length;
    if (this.bytes > this.maxBytes) await this.evict();
  }

  private async evict(): Promise<void> {
    if (this.evicting) return;
    this.evicting = true;
    try {
      // Drop oldest until under 90% of the cap.
      const target = this.maxBytes * 0.9;
      const sorted = [...this.entries!.entries()].sort((a, b) => a[1].atime - b[1].atime);
      for (const [k, e] of sorted) {
        if (this.bytes <= target) break;
        await rm(this.path(k), { force: true });
        this.entries!.delete(k);
        this.bytes -= e.size;
      }
    } finally {
      this.evicting = false;
    }
  }
}

/** ioredis-compatible subset. */
export interface RedisBufferClient {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, mode: 'EX', seconds: number): Promise<unknown>;
}

export class RedisResizeCache implements ResizeCache {
  constructor(
    private readonly client: RedisBufferClient,
    private readonly opts: { prefix?: string; ttlSeconds?: number } = {},
  ) {}

  private k(key: string): string {
    return (this.opts.prefix ?? 'drivebucket:img:') + key;
  }

  async get(key: string): Promise<CachedVariant | undefined> {
    const buf = await this.client.getBuffer(this.k(key));
    return buf ? decode(buf) : undefined;
  }

  async set(key: string, value: CachedVariant): Promise<void> {
    await this.client.set(this.k(key), encode(value), 'EX', this.opts.ttlSeconds ?? 7 * 86_400);
  }
}
