import { createHash, type Hash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EntityTooLarge } from './errors.js';
import type { Body } from './types.js';

export const KIB_256 = 256 * 1024;
/** Drive: multipart/simple uploads are for files of 5 MB or less. */
export const MULTIPART_MAX = 5 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export function assertChunkSize(size: number): void {
  if (!Number.isInteger(size) || size <= 0 || size % KIB_256 !== 0) {
    throw new TypeError(`chunkSize must be a positive multiple of 256 KiB (got ${size})`);
  }
}

export function isReadable(body: Body): body is Readable {
  return typeof (body as Readable).pipe === 'function' && typeof (body as Readable)[Symbol.asyncIterator] === 'function';
}

export function toBuffer(body: Exclude<Body, Readable>): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * Pull fixed-size pieces out of a stream while hashing and counting bytes. `read(n)` returns
 * exactly n bytes unless the stream ends first.
 */
export class ChunkReader {
  private readonly iter: AsyncIterator<unknown>;
  private buffered: Buffer[] = [];
  private bufferedLen = 0;
  private ended = false;
  readonly md5: Hash = createHash('md5');
  total = 0;

  constructor(
    source: Readable,
    private readonly maxBytes?: number,
  ) {
    // Errors before the first read would otherwise be unhandled 'error' events; iteration still
    // rethrows them because the stream keeps its `errored` state.
    source.on('error', () => undefined);
    this.iter = source[Symbol.asyncIterator]();
  }

  get eof(): boolean {
    return this.ended && this.bufferedLen === 0;
  }

  async read(n: number): Promise<Buffer> {
    while (this.bufferedLen < n && !this.ended) {
      const { value, done } = await this.iter.next();
      if (done) {
        this.ended = true;
        break;
      }
      const buf = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
      this.total += buf.length;
      if (this.maxBytes !== undefined && this.total > this.maxBytes) {
        await this.iter.return?.();
        throw new EntityTooLarge(`Body exceeds max size of ${this.maxBytes} bytes`);
      }
      this.md5.update(buf);
      this.buffered.push(buf);
      this.bufferedLen += buf.length;
    }
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered, this.bufferedLen);
    const out = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(out.length);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedLen = rest.length;
    return out;
  }

  /** Peek whether at least one more byte is available. */
  async hasMore(): Promise<boolean> {
    if (this.bufferedLen > 0) return true;
    if (this.ended) return false;
    const b = await this.read(1);
    if (b.length === 0) return false;
    this.buffered.unshift(b);
    this.bufferedLen += b.length;
    return true;
  }
}

export function bufferToReadable(buf: Buffer): Readable {
  return Readable.from([buf]);
}
