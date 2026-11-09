import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import Busboy from 'busboy';
import {
  AuthError,
  DriveApiError,
  type DriveAdapter,
  DriveBucketError,
  evaluateConditionals,
  ifRangeAllows,
  isDriveBucketError,
  parseRange,
  validateKey,
} from '@drivebucket/core';
import { EXTENSIONS, sniff, typeAllowed } from './sniff.js';

export interface UploadedFile {
  key: string;
  /** URL the file can be fetched from (this route, or `publicUrl(key)`). */
  url: string;
  size: number;
  etag: string;
  contentType: string;
  /** Original filename from the client (sanitized). */
  name: string;
}

export interface DriveRouteOptions {
  /** The adapter, or a function returning it (lazy: avoids creating clients at build time). */
  adapter: DriveAdapter | (() => DriveAdapter | Promise<DriveAdapter>);
  bucket: string;
  /** Gate uploads (and reads when `protectReads`). Return false → 401. */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /** Require `auth` for GET/HEAD too. Default false (anyone with the URL can read). */
  protectReads?: boolean;
  /** Per-file limit in bytes. Default 10 MB. */
  maxBytes?: number;
  /** Allowed types, e.g. ['image/*', 'application/pdf']. Checked against sniffed bytes when recognizable. */
  allowedTypes?: string[];
  /** Files per request. Default 1. */
  maxFiles?: number;
  /** Prefix for generated keys. Default `uploads/`. */
  keyPrefix?: string;
  /** Custom key generator. Must return a valid key; it is validated. */
  generateKey?: (info: { filename: string; contentType: string; ext: string; req: Request }) => string | Promise<string>;
  /** Cache-Control stored with uploads. Default `public, max-age=31536000, immutable` (keys are unique). */
  cacheControl?: string;
  /** Build the URL returned to clients, e.g. a CDN in front of drivebucket-server. Default: this route. */
  publicUrl?: (key: string, req: Request) => string;
}

type Ctx = { params?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined> };
type Handler = (req: Request, ctx?: Ctx) => Promise<Response>;

const RISKY_INLINE = /^(text\/html|image\/svg\+xml|application\/xhtml|text\/xml|application\/xml|application\/javascript|text\/javascript)/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function errorResponse(err: unknown): Response {
  // Failures talking to Drive are server problems; never forward Drive's message to clients.
  if (err instanceof DriveApiError || err instanceof AuthError) {
    console.error('[drivebucket/next]', err);
    return json(500, { error: { code: 'InternalError', message: 'Internal error' } });
  }
  if (isDriveBucketError(err) && err.status < 500) {
    return json(err.status, { error: { code: err.code, message: err.message } });
  }
  if (isDriveBucketError(err) && (err.code === 'SlowDown' || err.code === 'QuotaExceeded' || err.code === 'DailyUploadLimit')) {
    return json(503, { error: { code: err.code, message: 'Storage temporarily unavailable' } }, { 'retry-after': '5' });
  }
  console.error('[drivebucket/next]', err);
  return json(500, { error: { code: 'InternalError', message: 'Internal error' } });
}

const fail = (status: number, code: string, message: string) => new DriveBucketError(message, { code, status });

async function keyFromCtx(ctx: Ctx | undefined): Promise<string | undefined> {
  const params = ctx?.params ? await ctx.params : undefined;
  if (!params) return undefined;
  const v = Object.values(params).find((x) => x !== undefined);
  if (v === undefined) return undefined;
  const key = Array.isArray(v) ? v.join('/') : v;
  return key || undefined;
}

function sanitizeName(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (name ?? 'file').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120) || 'file';
}

/** Split off the first `n` bytes of a stream so they can be inspected before uploading. */
async function peek(src: Readable, n: number, onEnd: () => void): Promise<{ head: Buffer; rest: Readable; discard: () => Promise<void> }> {
  const it = src[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let done = false;
  while (head.length < n) {
    const r = await it.next();
    if (r.done) {
      done = true;
      break;
    }
    head = Buffer.concat([head, r.value as Buffer]);
  }
  const rest = Readable.from(
    (async function* () {
      yield head;
      if (!done) {
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          yield r.value as Buffer;
        }
      }
      onEnd();
    })(),
  );
  // On failure, busboy waits until this part is fully read; drain whatever is left.
  const discard = async () => {
    if (done) return;
    for (;;) {
      const r = await it.next();
      if (r.done) break;
    }
    done = true;
  };
  return { head, rest, discard };
}

/**
 * Route handlers for an App Router catch-all route. Put this in
 * `app/api/files/[[...key]]/route.ts`:
 *
 * ```ts
 * export const runtime = 'nodejs';
 * export const { GET, HEAD, POST } = createDriveRoute({ adapter, bucket: 'photos', auth: (req) => isSignedIn(req) });
 * ```
 *
 * POST takes `multipart/form-data` and streams each file to Drive (no buffering, no base64).
 * GET/HEAD serve `/api/files/<key>` with Range, ETag/304 and Cache-Control.
 */
export function createDriveRoute(opts: DriveRouteOptions): { GET: Handler; HEAD: Handler; POST: Handler } {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 1;
  const prefix = opts.keyPrefix ?? 'uploads/';
  const cacheControl = opts.cacheControl ?? 'public, max-age=31536000, immutable';
  let adapterPromise: Promise<DriveAdapter> | undefined;
  const getAdapter = () => (adapterPromise ??= Promise.resolve(typeof opts.adapter === 'function' ? opts.adapter() : opts.adapter));

  async function checkAuth(req: Request): Promise<void> {
    if (opts.auth && !(await opts.auth(req))) throw fail(401, 'Unauthorized', 'Unauthorized');
  }

  function urlFor(key: string, req: Request): string {
    if (opts.publicUrl) return opts.publicUrl(key, req);
    const u = new URL(req.url);
    const base = u.pathname.replace(/\/+$/, '');
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  const POST: Handler = async (req) => {
    try {
      await checkAuth(req);
      const ct = req.headers.get('content-type') ?? '';
      if (!/^multipart\/form-data/i.test(ct)) throw fail(415, 'UnsupportedMediaType', 'Send multipart/form-data');
      const declared = Number(req.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes * maxFiles + 64 * 1024) throw fail(413, 'EntityTooLarge', `Max ${maxBytes} bytes per file`);
      if (!req.body) throw fail(400, 'BadRequest', 'Empty body');
      const adapter = await getAdapter();

      const results: UploadedFile[] = [];
      const jobs: Promise<void>[] = [];
      let firstError: unknown;
      const busboy = Busboy({
        headers: { 'content-type': ct },
        limits: { files: maxFiles, fileSize: maxBytes, fields: 20, fieldSize: 4096, parts: maxFiles + 20 },
      });
      let filesLimit = false;
      busboy.on('filesLimit', () => (filesLimit = true));

      busboy.on('file', (_field, file, info) => {
        let peeked: Awaited<ReturnType<typeof peek>> | undefined;
        const job = (async () => {
          let truncated = false;
          file.on('limit', () => (truncated = true));
          peeked = await peek(file, 64, () => {
            if (truncated) throw fail(413, 'EntityTooLarge', `Max ${maxBytes} bytes per file`);
          });
          const { head, rest } = peeked;
          const sniffed = sniff(head);
          const declaredType = (info.mimeType || 'application/octet-stream').toLowerCase();
          // Trust recognizable bytes over the client's label.
          const contentType = sniffed ?? declaredType;
          if (!typeAllowed(contentType, opts.allowedTypes)) {
            throw fail(415, 'UnsupportedMediaType', `File type ${contentType} is not allowed`);
          }
          const name = sanitizeName(info.filename);
          const ext = EXTENSIONS[contentType] ?? '';
          const now = new Date();
          const key = opts.generateKey
            ? await opts.generateKey({ filename: name, contentType, ext, req })
            : `${prefix}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}${ext}`;
          validateKey(key);
          const res = await adapter.put(opts.bucket, key, rest, { contentType, cacheControl, metadata: { originalname: encodeURIComponent(name) } });
          results.push({ key, url: urlFor(key, req), size: res.size, etag: res.etag, contentType, name });
        })().catch(async (err) => {
          firstError ??= err;
          await peeked?.discard().catch(() => undefined);
          file.resume();
        });
        jobs.push(job);
      });

      const done = new Promise<void>((resolve, reject) => {
        busboy.on('close', resolve);
        busboy.on('error', (e) => reject(fail(400, 'MalformedBody', `Malformed multipart body: ${(e as Error).message}`)));
      });
      const body = Readable.fromWeb(req.body as unknown as NodeWebReadableStream);
      body.on('error', (e) => busboy.destroy(e));
      body.pipe(busboy);
      await done;
      await Promise.all(jobs);
      if (firstError || filesLimit) {
        // All-or-nothing: drop files already stored by this request.
        await Promise.all(results.map((r) => adapter.delete(opts.bucket, r.key, { permanent: true }).catch(() => undefined)));
        if (firstError) throw firstError;
        throw fail(413, 'TooManyFiles', `At most ${maxFiles} file(s) per request`);
      }
      if (results.length === 0) throw fail(400, 'NoFile', 'No file field in the form');
      return json(201, { files: results });
    } catch (err) {
      return errorResponse(err);
    }
  };

  const serve = async (req: Request, ctx: Ctx | undefined, head: boolean): Promise<Response> => {
    try {
      if (opts.protectReads) await checkAuth(req);
      const key = await keyFromCtx(ctx);
      if (!key) throw fail(404, 'NoSuchKey', 'Not found');
      validateKey(key);
      const adapter = await getAdapter();
      const info = await adapter.head(opts.bucket, key);
      const etag = `"${info.etag}"`;
      const v = { etag, lastModified: info.lastModified };
      const headers = new Headers({
        'content-type': info.contentType,
        etag,
        'last-modified': info.lastModified.toUTCString(),
        'cache-control': info.cacheControl ?? cacheControl,
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
      if (RISKY_INLINE.test(info.contentType)) headers.set('content-disposition', 'attachment');
      const hdrs = Object.fromEntries(req.headers);
      const cond = evaluateConditionals(hdrs, v);
      if (cond === 'not-modified') return new Response(null, { status: 304, headers });
      if (cond === 'precondition-failed') return json(412, { error: { code: 'PreconditionFailed', message: 'Precondition failed' } });

      const rangeHeader = req.headers.get('range') ?? undefined;
      const range = rangeHeader && ifRangeAllows(req.headers.get('if-range') ?? undefined, v) ? parseRange(rangeHeader) : undefined;
      if (range) {
        const unsat = 'suffix' in range ? range.suffix === 0 || info.size === 0 : range.start >= info.size;
        if (unsat) {
          headers.set('content-range', `bytes */${info.size}`);
          return new Response(null, { status: 416, headers });
        }
      }
      if (head) {
        headers.set('content-length', String(info.size));
        return new Response(null, { status: 200, headers });
      }
      const res = await adapter.read(opts.bucket, info, range ? { range } : {});
      headers.set('content-length', String(res.contentLength));
      let status = 200;
      if (res.range) {
        status = 206;
        headers.set('content-range', `bytes ${res.range.start}-${res.range.end}/${res.range.total}`);
      }
      const stream = Readable.toWeb(res.stream) as unknown as ReadableStream<Uint8Array>;
      return new Response(stream, { status, headers });
    } catch (err) {
      return errorResponse(err);
    }
  };

  return {
    POST,
    GET: (req, ctx) => serve(req, ctx, false),
    HEAD: (req, ctx) => serve(req, ctx, true),
  };
}

export { sniff, typeAllowed } from './sniff.js';
