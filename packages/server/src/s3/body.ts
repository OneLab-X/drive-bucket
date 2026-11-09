import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { HttpError } from '../http/s3-error.js';
import { AwsChunkedDecoder, Sha256Verifier } from './chunked.js';
import type { AuthContext } from './sigv4.js';

export interface DecodedBody {
  stream: Readable;
  /** Decoded length when the client declared it. */
  contentLength?: number;
}

/**
 * An 'error' emitted before anyone iterates the stream (e.g. the adapter is still awaiting a
 * Drive lookup) would be an unhandled 'error' event and crash the process. A no-op listener
 * prevents that; the error stays on `stream.errored`, so the consumer's read still throws it.
 */
function guard<T extends Readable>(s: T): T {
  s.on('error', () => undefined);
  return s;
}

function pipeWithErrors(src: Readable, dst: NodeJS.ReadWriteStream & Readable): Readable {
  guard(src);
  src.on('error', (err) => dst.destroy(err));
  src.on('aborted', () => dst.destroy(new HttpError(400, 'IncompleteBody', 'The request body terminated unexpectedly')));
  return guard(src.pipe(dst) as Readable);
}

function header(raw: IncomingMessage, name: string): string | undefined {
  const v = raw.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
}

/**
 * Turn the raw request into the object's bytes: decode aws-chunked framing, verify chunk
 * signatures and checksums, or verify a signed x-amz-content-sha256. Verification failures
 * surface as stream errors at (or before) end of body, i.e. before the Drive upload commits.
 */
export function decodeBody(raw: IncomingMessage, auth: AuthContext | undefined): DecodedBody {
  const payloadHash = auth?.payloadHash ?? 'UNSIGNED-PAYLOAD';
  const encoding = (header(raw, 'content-encoding') ?? '').toLowerCase();
  const decodedRaw = header(raw, 'x-amz-decoded-content-length');
  const decodedLength = decodedRaw !== undefined ? Number(decodedRaw) : undefined;
  if (decodedLength !== undefined && (!Number.isInteger(decodedLength) || decodedLength < 0)) {
    throw new HttpError(400, 'InvalidArgument', 'Invalid x-amz-decoded-content-length');
  }

  if (payloadHash.startsWith('STREAMING-') || encoding.split(',').map((s) => s.trim()).includes('aws-chunked')) {
    const signed = payloadHash.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD');
    if (payloadHash.startsWith('STREAMING-') && !signed && payloadHash !== 'STREAMING-UNSIGNED-PAYLOAD-TRAILER') {
      throw new HttpError(400, 'InvalidArgument', `Unsupported x-amz-content-sha256: ${payloadHash}`);
    }
    const decoder = new AwsChunkedDecoder({
      ...(signed && auth ? { signed: auth, trailerSigned: payloadHash.endsWith('-TRAILER') } : {}),
      ...(decodedLength !== undefined ? { decodedLength } : {}),
    });
    return { stream: pipeWithErrors(raw, decoder), ...(decodedLength !== undefined ? { contentLength: decodedLength } : {}) };
  }

  const cl = header(raw, 'content-length');
  const contentLength = cl !== undefined ? Number(cl) : undefined;
  if (/^[0-9a-f]{64}$/i.test(payloadHash)) {
    return { stream: pipeWithErrors(raw, new Sha256Verifier(payloadHash)), ...(contentLength !== undefined ? { contentLength } : {}) };
  }
  if (payloadHash !== 'UNSIGNED-PAYLOAD') throw new HttpError(400, 'InvalidArgument', `Unsupported x-amz-content-sha256: ${payloadHash}`);
  return { stream: guard(raw), ...(contentLength !== undefined ? { contentLength } : {}) };
}

/** Content-MD5 (base64) → hex, or undefined. */
export function contentMd5Hex(raw: IncomingMessage): string | undefined {
  const v = header(raw, 'content-md5');
  if (v === undefined) return undefined;
  const b = Buffer.from(v, 'base64');
  if (b.length !== 16 || b.toString('base64') !== v.trim()) throw new HttpError(400, 'InvalidDigest', 'The Content-MD5 you specified was invalid.');
  return b.toString('hex');
}

/** x-amz-meta-* headers → metadata. */
export function metadataFromHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-amz-meta-') && v !== undefined) out[k.slice('x-amz-meta-'.length)] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}
