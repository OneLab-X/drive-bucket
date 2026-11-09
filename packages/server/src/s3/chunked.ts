import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import * as zlib from 'node:zlib';
import { HttpError } from '../http/s3-error.js';
import { chunkSignature, safeEqualHex, trailerSignature, type AuthContext } from './sigv4.js';

const MAX_CHUNK_HEADER = 4096;
const MAX_TRAILER = 16 * 1024;

type Ctx = Pick<AuthContext, 'signingKey' | 'amzDate' | 'scope' | 'signature'>;

/**
 * Decode `Content-Encoding: aws-chunked` bodies:
 *  - STREAMING-AWS4-HMAC-SHA256-PAYLOAD[-TRAILER]: each chunk carries a chained signature.
 *  - STREAMING-UNSIGNED-PAYLOAD-TRAILER: plain chunks + checksum trailer (AWS SDK default since 2025).
 * Verifies chunk/trailer signatures and CRC32/SHA-1/SHA-256 trailer checksums. Any failure errors
 * the stream, which aborts the Drive upload before its final chunk is committed.
 */
export class AwsChunkedDecoder extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'header' | 'data' | 'trailer' | 'done' = 'header';
  private remaining = 0;
  private chunkSig: string | undefined;
  private prevSig: string;
  private emitted = 0;
  private trailerLines: string[] = [];
  private readonly crc = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
  private crcValue = 0;
  private readonly sha256 = createHash('sha256');
  private readonly sha1 = createHash('sha1');
  private current: Buffer[] = [];

  constructor(
    private readonly opts: { signed?: Ctx; decodedLength?: number; trailerSigned?: boolean },
  ) {
    super();
    this.prevSig = opts.signed?.signature ?? '';
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.drain();
      // Some clients end with "0\r\n" and no blank line.
      if (this.state === 'trailer' && this.buf.length === 0) this.finishTrailer();
      if (this.state !== 'done') throw new HttpError(400, 'IncompleteBody', 'The request body terminated unexpectedly');
      if (this.opts.decodedLength !== undefined && this.emitted !== this.opts.decodedLength) {
        throw new HttpError(400, 'IncompleteBody', 'You did not provide the number of bytes specified by the x-amz-decoded-content-length header');
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private malformed(): never {
    throw new HttpError(400, 'InvalidRequest', 'Malformed aws-chunked body');
  }

  private drain(): void {
    for (;;) {
      if (this.state === 'header') {
        const i = this.buf.indexOf('\r\n');
        if (i < 0) {
          if (this.buf.length > MAX_CHUNK_HEADER) this.malformed();
          return;
        }
        const line = this.buf.subarray(0, i).toString('latin1');
        this.buf = this.buf.subarray(i + 2);
        const [sizeHex, ...ext] = line.split(';');
        if (!sizeHex || !/^[0-9a-fA-F]+$/.test(sizeHex)) this.malformed();
        this.remaining = parseInt(sizeHex, 16);
        const sigExt = ext.find((e) => e.startsWith('chunk-signature='));
        this.chunkSig = sigExt?.slice('chunk-signature='.length);
        if (this.opts.signed && !this.chunkSig) throw new HttpError(403, 'SignatureDoesNotMatch', 'Missing chunk signature');
        this.current = [];
        if (this.remaining === 0) {
          this.verifyChunk(Buffer.alloc(0));
          this.state = 'trailer';
        } else this.state = 'data';
      } else if (this.state === 'data') {
        if (this.buf.length === 0) return;
        const take = Math.min(this.remaining, this.buf.length);
        if (take > 0) {
          const piece = this.buf.subarray(0, take);
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
          this.emit_(piece);
        }
        if (this.remaining > 0) return;
        if (this.buf.length < 2) return;
        if (this.buf[0] !== 13 || this.buf[1] !== 10) this.malformed();
        this.buf = this.buf.subarray(2);
        this.verifyChunk(Buffer.concat(this.current));
        this.state = 'header';
      } else if (this.state === 'trailer') {
        const i = this.buf.indexOf('\r\n');
        if (i < 0) {
          if (this.buf.length > MAX_TRAILER) this.malformed();
          return;
        }
        const line = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        if (line === '') {
          this.finishTrailer();
          return;
        }
        this.trailerLines.push(line);
        if (this.trailerLines.length > 32) this.malformed();
      } else {
        // done: ignore anything after the terminator
        this.buf = Buffer.alloc(0);
        return;
      }
    }
  }

  private emit_(piece: Buffer): void {
    this.emitted += piece.length;
    if (this.opts.signed) this.current.push(piece);
    if (this.crc) this.crcValue = this.crc(piece, this.crcValue);
    this.sha256.update(piece);
    this.sha1.update(piece);
    this.push(piece);
  }

  private verifyChunk(data: Buffer): void {
    if (!this.opts.signed) return;
    const expected = chunkSignature(this.opts.signed, this.prevSig, data);
    if (!this.chunkSig || !safeEqualHex(expected, this.chunkSig.toLowerCase())) {
      throw new HttpError(403, 'SignatureDoesNotMatch', 'The chunk signature does not match');
    }
    this.prevSig = expected;
    this.current = [];
  }

  private finishTrailer(): void {
    const headers = new Map<string, string>();
    for (const l of this.trailerLines) {
      const i = l.indexOf(':');
      if (i < 0) this.malformed();
      headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
    }
    if (this.opts.signed && this.opts.trailerSigned) {
      const sig = headers.get('x-amz-trailer-signature');
      const canonical = [...headers].filter(([k]) => k !== 'x-amz-trailer-signature').map(([k, v]) => `${k}:${v}\n`).join('');
      const expected = trailerSignature(this.opts.signed, this.prevSig, canonical);
      if (!sig || !safeEqualHex(expected, sig.toLowerCase())) throw new HttpError(403, 'SignatureDoesNotMatch', 'The trailer signature does not match');
    }
    const check = (name: string, actual: string | undefined) => {
      const want = headers.get(name);
      if (want !== undefined && actual !== undefined && want !== actual) {
        throw new HttpError(400, 'BadDigest', `The ${name.replace('x-amz-checksum-', '').toUpperCase()} you specified did not match the calculated checksum.`);
      }
    };
    if (this.crc) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(this.crcValue >>> 0);
      check('x-amz-checksum-crc32', b.toString('base64'));
    }
    check('x-amz-checksum-sha256', this.sha256.digest('base64'));
    check('x-amz-checksum-sha1', this.sha1.digest('base64'));
    this.state = 'done';
  }
}

/** Verifies a hex x-amz-content-sha256 against the body; errors at end-of-stream on mismatch. */
export class Sha256Verifier extends Transform {
  private readonly hash = createHash('sha256');
  constructor(private readonly expectedHex: string) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    cb(null, chunk);
  }
  override _flush(cb: TransformCallback): void {
    const got = this.hash.digest('hex');
    if (got !== this.expectedHex.toLowerCase()) {
      cb(new HttpError(400, 'XAmzContentSHA256Mismatch', "The provided 'x-amz-content-sha256' header does not match what was computed."));
    } else cb();
  }
}
