import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DriveAdapter, ObjectUpload, PutOptions, PutResult } from '@drivebucket/core';
import { HttpError } from '../http/s3-error.js';

interface Part {
  etag: string;
  size: number;
  file?: string;
  fed: boolean;
}

interface Upload {
  id: string;
  bucket: string;
  key: string;
  createdAt: Date;
  lastActivity: number;
  upload: ObjectUpload;
  parts: Map<number, Part>;
  nextPart: number;
  feeding: Promise<void>;
  error?: unknown;
  closed: boolean;
}

export interface MultipartOptions {
  /** Where out-of-order parts are spooled. Default `<os tmp>/drivebucket-mpu`. */
  tmpDir?: string;
  /** Abandon uploads idle this long. Default 24 h (Drive sessions last a week). */
  ttlMs?: number;
  /** Max concurrently open uploads. Default 1000. */
  maxUploads?: number;
}

const noSuchUpload = () =>
  new HttpError(404, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.');

/**
 * S3 multipart on top of one Drive resumable session.
 *
 * Every part is spooled to disk first (so parts can arrive concurrently and out of order, and a
 * retried part can replace its previous attempt), then fed into the session strictly in part
 * order by a single background drain. A part that has already been fed can't be replaced.
 * Complete must list exactly parts 1..N. State is in-process: run one server instance per
 * upload (sticky sessions) or a single replica.
 */
export class MultipartManager {
  private readonly uploads = new Map<string, Upload>();
  private readonly tmpDir: string;
  private readonly ttlMs: number;
  private readonly maxUploads: number;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly adapter: DriveAdapter,
    opts: MultipartOptions = {},
  ) {
    this.tmpDir = opts.tmpDir ?? join(tmpdir(), 'drivebucket-mpu');
    this.ttlMs = opts.ttlMs ?? 24 * 3600 * 1000;
    this.maxUploads = opts.maxUploads ?? 1000;
    this.timer = setInterval(() => void this.sweep(), Math.min(this.ttlMs, 10 * 60 * 1000));
    this.timer.unref();
  }

  get size(): number {
    return this.uploads.size;
  }

  async create(bucket: string, key: string, opts: Omit<PutOptions, 'contentLength'>): Promise<string> {
    if (this.uploads.size >= this.maxUploads) throw new HttpError(503, 'SlowDown', 'Too many concurrent multipart uploads');
    const upload = await this.adapter.createUpload(bucket, key, opts);
    const id = randomBytes(24).toString('base64url');
    this.uploads.set(id, {
      id,
      bucket,
      key,
      createdAt: new Date(),
      lastActivity: Date.now(),
      upload,
      parts: new Map(),
      nextPart: 1,
      feeding: Promise.resolve(),
      closed: false,
    });
    return id;
  }

  private get(id: string, bucket: string, key: string): Upload {
    const u = this.uploads.get(id);
    if (!u || u.closed || u.bucket !== bucket || u.key !== key) throw noSuchUpload();
    u.lastActivity = Date.now();
    return u;
  }

  async uploadPart(id: string, bucket: string, key: string, partNumber: number, body: Readable, expectedMd5?: string): Promise<string> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new HttpError(400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000, inclusive');
    }
    const u = this.get(id, bucket, key);
    if (u.error) throw this.failure(u);
    await mkdir(this.tmpDir, { recursive: true });
    const file = join(this.tmpDir, `${id}.${partNumber}.${randomBytes(6).toString('hex')}`);
    const md5 = createHash('md5');
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const c of src) {
            md5.update(c);
            size += c.length;
            yield c;
          }
        },
        createWriteStream(file),
      );
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
    const etag = md5.digest('hex');
    if (expectedMd5 !== undefined && expectedMd5 !== etag) {
      await rm(file, { force: true });
      throw new HttpError(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
    }
    if (u.closed) {
      await rm(file, { force: true });
      throw noSuchUpload();
    }
    const prev = u.parts.get(partNumber);
    if (prev?.fed) {
      await rm(file, { force: true });
      if (prev.etag === etag) return etag; // idempotent retry of an already-committed part
      throw new HttpError(400, 'InvalidPart', `Part ${partNumber} was already written to Drive and cannot be replaced`);
    }
    if (prev?.file) await rm(prev.file, { force: true });
    u.parts.set(partNumber, { etag, size, file, fed: false });
    this.scheduleDrain(u);
    return etag;
  }

  private failure(u: Upload): HttpError {
    const e = u.error as { code?: string; status?: number; message?: string } | undefined;
    if (e && typeof e.status === 'number' && e.status < 500 && e.code) return new HttpError(e.status, e.code, e.message ?? 'Upload failed');
    return new HttpError(500, 'InternalError', 'Writing parts to storage failed; abort and retry the upload');
  }

  private scheduleDrain(u: Upload): void {
    u.feeding = u.feeding.then(async () => {
      if (u.error || u.closed) return;
      try {
        for (;;) {
          const part = u.parts.get(u.nextPart);
          if (!part || part.fed || !part.file) return;
          const file = part.file;
          for await (const c of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
            await u.upload.write(c as Buffer);
          }
          part.fed = true;
          delete part.file;
          await rm(file, { force: true });
          u.nextPart++;
        }
      } catch (err) {
        u.error = err;
      }
    });
  }

  async complete(id: string, bucket: string, key: string, list: Array<{ partNumber: number; etag: string }>): Promise<PutResult> {
    const u = this.get(id, bucket, key);
    if (list.length === 0) throw new HttpError(400, 'MalformedXML', 'You must specify at least one part');
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.partNumber <= list[i - 1]!.partNumber) {
        throw new HttpError(400, 'InvalidPartOrder', 'The list of parts was not in ascending order. Parts must be ordered by part number.');
      }
    }
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      const have = u.parts.get(p.partNumber);
      if (!have || have.etag !== p.etag.replace(/"/g, '').toLowerCase()) {
        throw new HttpError(400, 'InvalidPart', 'One or more of the specified parts could not be found or the specified entity tag might not have matched the part\'s entity tag.');
      }
      if (p.partNumber !== i + 1) {
        throw new HttpError(400, 'InvalidPart', 'drivebucket requires parts numbered contiguously from 1 (no gaps)');
      }
    }
    if (u.parts.size !== list.length) {
      throw new HttpError(400, 'InvalidPart', 'drivebucket requires Complete to include every uploaded part');
    }
    u.closed = true;
    try {
      await u.feeding;
      if (u.error) throw this.failure(u);
      if (u.nextPart !== list.length + 1) throw new HttpError(500, 'InternalError', 'Not all parts were written');
      return await u.upload.complete();
    } finally {
      this.uploads.delete(id);
      await this.cleanup(u);
    }
  }

  async abort(id: string, bucket: string, key: string): Promise<void> {
    const u = this.get(id, bucket, key);
    u.closed = true;
    u.upload.abort();
    this.uploads.delete(id);
    await u.feeding.catch(() => undefined);
    await this.cleanup(u);
  }

  private async cleanup(u: Upload): Promise<void> {
    for (const p of u.parts.values()) if (p.file) await rm(p.file, { force: true });
  }

  async sweep(now = Date.now()): Promise<number> {
    let n = 0;
    for (const u of [...this.uploads.values()]) {
      if (now - u.lastActivity > this.ttlMs) {
        await this.abort(u.id, u.bucket, u.key).catch(() => undefined);
        n++;
      }
    }
    return n;
  }

  close(): void {
    clearInterval(this.timer);
  }
}
