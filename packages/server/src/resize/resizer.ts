import { createLimiter, type Limiter } from '@drivebucket/core';
import { HttpError } from '../http/s3-error.js';
import type { CachedVariant, ResizeCache } from './cache.js';
import type { ResizeParams } from './params.js';

type SharpModule = (typeof import('sharp'))['default'];

let sharpPromise: Promise<SharpModule> | undefined;
function loadSharp(): Promise<SharpModule> {
  sharpPromise ??= import('sharp').then((m) => (m.default ?? m) as SharpModule);
  return sharpPromise;
}

export interface ResizerOptions {
  cache?: ResizeCache;
  /** Parallel sharp jobs. Default 2. */
  concurrency?: number;
  /** Max decoded pixels (width*height). Default 50 MP. */
  maxInputPixels?: number;
  onCache?: (hit: boolean) => void;
  onResize?: (durationMs: number) => void;
}

/** Runs sharp with a concurrency cap, de-duplicates identical in-flight work, and caches results. */
export class Resizer {
  private readonly limit: Limiter;
  private readonly inflight = new Map<string, Promise<CachedVariant>>();

  constructor(private readonly opts: ResizerOptions = {}) {
    this.limit = createLimiter(opts.concurrency ?? 2);
  }

  async getOrCreate(key: string, params: ResizeParams, loadSource: () => Promise<Buffer>): Promise<CachedVariant> {
    const cached = await this.opts.cache?.get(key).catch(() => undefined);
    if (cached) {
      this.opts.onCache?.(true);
      return cached;
    }
    this.opts.onCache?.(false);
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.limit(async () => {
      const source = await loadSource();
      const out = await this.transform(source, params);
      await this.opts.cache?.set(key, out).catch(() => undefined);
      return out;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async transform(source: Buffer, p: ResizeParams): Promise<CachedVariant> {
    const sharp = await loadSharp();
    const t0 = performance.now();
    try {
      let img = sharp(source, { limitInputPixels: this.opts.maxInputPixels ?? 50_000_000, failOn: 'error' }).rotate();
      if (p.width !== undefined || p.height !== undefined) {
        img = img.resize({
          ...(p.width !== undefined ? { width: p.width } : {}),
          ...(p.height !== undefined ? { height: p.height } : {}),
          fit: p.fit,
          withoutEnlargement: true,
        });
      }
      const body = await img.toFormat(p.format, { quality: p.quality }).toBuffer();
      return { body, contentType: `image/${p.format}` };
    } catch (err) {
      throw new HttpError(422, 'InvalidImage', `Could not process image: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      this.opts.onResize?.(performance.now() - t0);
    }
  }
}
