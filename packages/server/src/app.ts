import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { type DriveAdapter, type ObjectInfo, validateBucketName, validateKey } from '@drivebucket/core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { evaluateConditionals, ifRangeAllows, type Validators } from './http/conditional.js';
import { parseRange } from './http/range.js';
import { HttpError, s3ErrorXml, toS3Error, xmlEscape } from './http/s3-error.js';
import { createMetrics, observeAdapter, type Metrics } from './metrics.js';
import type { ResizeCache } from './resize/cache.js';
import { parseResizeParams, RESIZABLE_TYPES, variantKey, wantsResize, type ResizeLimits } from './resize/params.js';
import { Resizer } from './resize/resizer.js';
import { contentMd5Hex, decodeBody, metadataFromHeaders } from './s3/body.js';
import { MultipartManager, type MultipartOptions } from './s3/multipart.js';
import { hasSigV4, parseQuery, splitUrl, verifySigV4, type AuthContext, type S3Credential } from './s3/sigv4.js';
import { readXmlBody, S3_NS, xml } from './s3/xml.js';

export interface BucketPolicy {
  /** Serve objects without auth (GET/HEAD only). Files stay private in Drive. */
  public?: boolean;
  /** Cache-Control when the object has none. */
  cacheControl?: string;
}

export interface ResizeOptions extends Partial<ResizeLimits> {
  cache?: ResizeCache;
  /** Parallel sharp jobs. Default 2. */
  concurrency?: number;
  /** Refuse to resize sources larger than this. Default 25 MB. */
  maxSourceBytes?: number;
  maxInputPixels?: number;
}

export interface S3Options {
  /** Access keys for SigV4. Without any, signed requests are rejected and only the public proxy works. */
  credentials: S3Credential[];
  /** Region clients sign for; `auto` (default) accepts any. */
  region?: string;
  /** Allowed clock skew. Default 15 min. */
  maxSkewMs?: number;
  multipart?: MultipartOptions;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface CorsOptions {
  /** Allowed origins, or `*`. */
  origins: string[] | '*';
  /** Preflight cache. Default 3600 s. */
  maxAgeSeconds?: number;
}

export interface ServerOptions {
  adapter: DriveAdapter;
  buckets?: Record<string, BucketPolicy>;
  /** Cache-Control for public objects that set none. Default `public, max-age=3600`. */
  defaultCacheControl?: string;
  /** S3-compatible API (SigV4, presigned URLs, multipart). */
  s3?: S3Options;
  /** Extra hook to allow unsigned GET/HEAD on non-public buckets. */
  authorize?: (ctx: { bucket: string; key: string; request: FastifyRequest }) => boolean | Promise<boolean>;
  /** Image resizing on `?w=&h=&format=&q=&fit=`. `false` disables. Default enabled. */
  resize?: ResizeOptions | false;
  /** Prometheus endpoint. Default enabled at `/-/metrics`. */
  metrics?: boolean | { path?: string; defaultMetrics?: boolean };
  /** Emit `x-amz-meta-*` on unsigned proxy responses. Default false. Signed requests always get them. */
  exposeMetadata?: boolean;
  /** Content types served inline; anything else gets `Content-Disposition: attachment`. */
  inlineTypes?: (contentType: string) => boolean;
  /** CORS for browser uploads to presigned URLs. Off by default. */
  cors?: CorsOptions;
  /** Max object size accepted by PutObject/UploadPart (bytes). */
  maxObjectBytes?: number;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: FastifyServerOptions['trustProxy'];
}

const DEFAULT_INLINE = (ct: string) =>
  /^(image\/(?!svg)|video\/|audio\/|font\/)/.test(ct) || ct === 'application/pdf' || ct.startsWith('text/plain');

/** Drop query strings from logged URLs: presigned URLs carry credentials in the query. */
function redactUrl(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? url : `${url.slice(0, i)}?[redacted]`;
}

function defaultLogger(): FastifyServerOptions['logger'] {
  return {
    level: process.env.DRIVEBUCKET_LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-amz-security-token"]'],
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url), ip: req.ip }),
    },
  };
}

const quote = (etag: string) => `"${etag}"`;

function setObjectHeaders(
  reply: FastifyReply,
  o: { contentType: string; etag: string; lastModified: Date; cacheControl: string },
  inline: (ct: string) => boolean,
): void {
  reply.header('Content-Type', o.contentType);
  reply.header('ETag', o.etag);
  reply.header('Last-Modified', o.lastModified.toUTCString());
  reply.header('Cache-Control', o.cacheControl);
  reply.header('X-Content-Type-Options', 'nosniff');
  // User content on your domain: never let it run scripts.
  reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (!inline(o.contentType)) reply.header('Content-Disposition', 'attachment');
}

async function readToBuffer(stream: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > max) {
      stream.destroy();
      throw new HttpError(413, 'EntityTooLarge', 'Source image too large to resize');
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function headerStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(',') : v;
}

/** Response header overrides allowed on signed GetObject (S3 `response-*` query params). */
const RESPONSE_OVERRIDES: Record<string, string> = {
  'response-content-type': 'Content-Type',
  'response-content-disposition': 'Content-Disposition',
  'response-cache-control': 'Cache-Control',
  'response-content-language': 'Content-Language',
  'response-expires': 'Expires',
  'response-content-encoding': 'Content-Encoding',
};

export interface DrivebucketServer extends FastifyInstance {
  drivebucket: { metrics: Metrics | undefined; resizer: Resizer | undefined; multipart: MultipartManager | undefined };
}

type Params = { bucket: string; '*'?: string };

export async function createServer(opts: ServerOptions): Promise<DrivebucketServer> {
  const app = Fastify({
    logger: opts.logger ?? defaultLogger(),
    trustProxy: opts.trustProxy ?? false,
    routerOptions: { maxParamLength: 4096 },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  const adapter = opts.adapter;
  const inline = opts.inlineTypes ?? DEFAULT_INLINE;
  const defaultCacheControl = opts.defaultCacheControl ?? 'public, max-age=3600';
  const region = opts.s3?.region ?? 'auto';
  const responseRegion = region === 'auto' ? 'us-east-1' : region;

  // ---------------------------------------------------------------- metrics / resize / multipart

  const metricsCfg = opts.metrics === false ? undefined : typeof opts.metrics === 'object' ? opts.metrics : {};
  const metrics = metricsCfg ? createMetrics({ ...(metricsCfg.defaultMetrics !== undefined ? { defaultMetrics: metricsCfg.defaultMetrics } : {}) }) : undefined;
  const unobserve = metrics ? observeAdapter(adapter, metrics) : undefined;

  const resizeCfg = opts.resize === false ? undefined : (opts.resize ?? {});
  const limits: ResizeLimits = {
    maxWidth: resizeCfg?.maxWidth ?? 4096,
    maxHeight: resizeCfg?.maxHeight ?? 4096,
    defaultQuality: resizeCfg?.defaultQuality ?? 80,
    ...(resizeCfg?.allowedWidths ? { allowedWidths: resizeCfg.allowedWidths } : {}),
    ...(resizeCfg?.allowedHeights ? { allowedHeights: resizeCfg.allowedHeights } : {}),
  };
  const maxSourceBytes = resizeCfg?.maxSourceBytes ?? 25 * 1024 * 1024;
  const resizer = resizeCfg
    ? new Resizer({
        ...(resizeCfg.cache ? { cache: resizeCfg.cache } : {}),
        ...(resizeCfg.concurrency !== undefined ? { concurrency: resizeCfg.concurrency } : {}),
        ...(resizeCfg.maxInputPixels !== undefined ? { maxInputPixels: resizeCfg.maxInputPixels } : {}),
        ...(metrics
          ? {
              onCache: (hit: boolean) => metrics.resizeCache.inc({ result: hit ? 'hit' : 'miss' }),
              onResize: (ms: number) => metrics.resizeDuration.observe(ms / 1000),
            }
          : {}),
      })
    : undefined;
  const multipart = opts.s3 ? new MultipartManager(adapter, opts.s3.multipart) : undefined;

  const server = app as unknown as DrivebucketServer;
  server.decorate('drivebucket', { metrics, resizer, multipart });
  app.addHook('onClose', async () => {
    unobserve?.();
    multipart?.close();
  });

  // Keep request bodies as raw streams: the S3 handlers decode/verify them themselves.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  // ---------------------------------------------------------------- errors

  app.setErrorHandler((err, request, reply) => {
    const e = toS3Error(err);
    if (e.status >= 500) request.log.error({ err }, 'request failed');
    else request.log.debug({ code: e.code }, 'request rejected');
    const resource = request.url.split('?')[0] ?? '/';
    reply.status(e.status).header('Content-Type', 'application/xml').header('x-amz-request-id', request.id);
    if (e.code === 'InvalidRange' && (err as { size?: number }).size !== undefined) {
      reply.header('Content-Range', `bytes */${(err as { size: number }).size}`);
    }
    if (e.code === 'SlowDown') reply.header('Retry-After', '1');
    // An unread request body would otherwise keep the socket busy; close after replying.
    if (!request.raw.readableEnded && request.raw.readable) reply.header('Connection', 'close');
    if (request.method === 'HEAD') return reply.send();
    return reply.send(s3ErrorXml(e, resource, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).header('Content-Type', 'application/xml');
    return reply.send(s3ErrorXml({ status: 404, code: 'NotFound', message: 'Not found' }, request.url.split('?')[0] ?? '/', request.id));
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-amz-request-id', request.id);
  });

  // ---------------------------------------------------------------- CORS

  if (opts.cors) {
    const cors = opts.cors;
    const allowed = (origin: string) => cors.origins === '*' || cors.origins.includes(origin);
    app.addHook('onRequest', async (request, reply) => {
      const origin = headerStr(request.headers.origin);
      if (!origin || !allowed(origin)) return;
      reply.header('Access-Control-Allow-Origin', cors.origins === '*' ? '*' : origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges, Last-Modified, x-amz-request-id, x-amz-version-id');
    });
    app.options('/*', async (request, reply) => {
      const origin = headerStr(request.headers.origin);
      if (!origin || !allowed(origin)) throw new HttpError(403, 'AccessForbidden', 'CORSResponse: This CORS request is not allowed.');
      const reqHeaders = headerStr(request.headers['access-control-request-headers']);
      reply.header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE');
      if (reqHeaders) reply.header('Access-Control-Allow-Headers', reqHeaders.slice(0, 2048));
      reply.header('Access-Control-Max-Age', String(cors.maxAgeSeconds ?? 3600));
      return reply.status(204).send();
    });
  }

  // ---------------------------------------------------------------- metrics + health

  if (metrics) {
    app.addHook('onResponse', async (request, reply) => {
      const route = request.routeOptions.url ?? 'unmatched';
      metrics.httpRequests.inc({ method: request.method, route, status: String(reply.statusCode) });
      metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    });
    app.get(metricsCfg?.path ?? '/-/metrics', async (_req, reply) => {
      reply.header('Content-Type', metrics.registry.contentType);
      return metrics.registry.metrics();
    });
  }

  app.get('/-/healthy', async () => ({ ok: true }));
  app.get('/-/ready', async (_req, reply) => {
    try {
      await adapter.init();
      return { ok: true };
    } catch (err) {
      reply.status(503);
      return { ok: false, error: toS3Error(err).code };
    }
  });

  // ---------------------------------------------------------------- auth

  function authenticate(request: FastifyRequest): AuthContext | undefined {
    const req = { method: request.method, rawUrl: request.raw.url ?? '/', headers: request.headers };
    if (!hasSigV4(req)) return undefined;
    if (!opts.s3 || opts.s3.credentials.length === 0) {
      throw new HttpError(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');
    }
    return verifySigV4(req, {
      credentials: opts.s3.credentials,
      region,
      ...(opts.s3.maxSkewMs !== undefined ? { maxSkewMs: opts.s3.maxSkewMs } : {}),
      ...(opts.s3.now ? { now: opts.s3.now } : {}),
    });
  }

  function canAccessBucket(auth: AuthContext, bucket: string): boolean {
    const b = auth.credential.buckets ?? '*';
    return b === '*' || b.includes(bucket);
  }

  function requireAuth(auth: AuthContext | undefined, bucket: string | undefined, write: boolean): AuthContext {
    if (!auth) throw new HttpError(403, 'AccessDenied', 'Access Denied');
    if (bucket !== undefined && !canAccessBucket(auth, bucket)) throw new HttpError(403, 'AccessDenied', 'Access Denied');
    if (write && auth.credential.readOnly) throw new HttpError(403, 'AccessDenied', 'Access Denied');
    return auth;
  }

  // ---------------------------------------------------------------- GET/HEAD object

  async function serveObject(
    request: FastifyRequest,
    reply: FastifyReply,
    bucket: string,
    key: string,
    auth: AuthContext | undefined,
    query: Map<string, string>,
  ) {
    const policy = opts.buckets?.[bucket] ?? {};
    if (auth) requireAuth(auth, bucket, false);
    else if (!policy.public && !(opts.authorize && (await opts.authorize({ bucket, key, request })))) {
      throw new HttpError(403, 'AccessDenied', 'Access Denied');
    }
    const info = await adapter.head(bucket, key);
    const cacheControl = info.cacheControl ?? policy.cacheControl ?? (policy.public && !auth ? defaultCacheControl : 'private, max-age=0');

    const q = Object.fromEntries(query);
    if (resizer && wantsResize(q)) return serveVariant(request, reply, bucket, info, cacheControl, q);

    const v: Validators = { etag: quote(info.etag), lastModified: info.lastModified };
    setObjectHeaders(reply, { contentType: info.contentType, etag: v.etag, lastModified: v.lastModified, cacheControl }, inline);
    reply.header('Accept-Ranges', 'bytes');
    if (auth || opts.exposeMetadata) for (const [k, val] of Object.entries(info.metadata)) reply.header(`x-amz-meta-${k}`, val);
    if (auth) {
      for (const [param, h] of Object.entries(RESPONSE_OVERRIDES)) {
        const val = query.get(param);
        if (val !== undefined) reply.header(h, val);
      }
    }

    const cond = evaluateConditionals(request.headers, v);
    if (cond === 'precondition-failed') throw new HttpError(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
    if (cond === 'not-modified') return reply.status(304).send();

    const rangeHeader = headerStr(request.headers.range);
    const range = rangeHeader && ifRangeAllows(headerStr(request.headers['if-range']), v) ? parseRange(rangeHeader) : undefined;
    if (range) {
      const unsat = 'suffix' in range ? range.suffix === 0 || info.size === 0 : range.start >= info.size;
      if (unsat) throw Object.assign(new HttpError(416, 'InvalidRange', 'The requested range is not satisfiable'), { size: info.size });
    }

    if (request.method === 'HEAD') {
      if (range) {
        const start = 'suffix' in range ? Math.max(0, info.size - range.suffix) : range.start;
        const end = 'suffix' in range ? info.size - 1 : Math.min(range.end ?? info.size - 1, info.size - 1);
        reply.status(206).header('Content-Range', `bytes ${start}-${end}/${info.size}`).header('Content-Length', end - start + 1);
      } else reply.header('Content-Length', info.size);
      return reply.send();
    }

    const res = await adapter.read(bucket, info, range ? { range } : {});
    reply.header('Content-Length', res.contentLength);
    if (res.range) reply.status(206).header('Content-Range', `bytes ${res.range.start}-${res.range.end}/${res.range.total}`);
    return reply.send(res.stream);
  }

  async function serveVariant(
    request: FastifyRequest,
    reply: FastifyReply,
    bucket: string,
    info: ObjectInfo,
    cacheControl: string,
    query: Record<string, unknown>,
  ) {
    if (!RESIZABLE_TYPES.has(info.contentType)) throw new HttpError(400, 'InvalidArgument', `Cannot resize ${info.contentType}`);
    const params = parseResizeParams(query, limits, info.contentType, headerStr(request.headers.accept));
    const vkey = variantKey(bucket, info.key, info.etag, params);
    const v: Validators = { etag: quote(`${info.etag}-${vkey.slice(0, 16)}`), lastModified: info.lastModified };
    setObjectHeaders(reply, { contentType: `image/${params.format}`, etag: v.etag, lastModified: v.lastModified, cacheControl }, inline);
    if (params.negotiated) reply.header('Vary', 'Accept');

    const cond = evaluateConditionals(request.headers, v);
    if (cond === 'precondition-failed') throw new HttpError(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
    if (cond === 'not-modified') return reply.status(304).send();
    if (info.size > maxSourceBytes) throw new HttpError(413, 'EntityTooLarge', 'Source image too large to resize');

    const out = await resizer!.getOrCreate(vkey, params, async () => {
      const res = await adapter.read(bucket, info);
      return readToBuffer(res.stream, maxSourceBytes);
    });
    reply.header('Content-Length', out.body.length);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(out.body);
  }

  // ---------------------------------------------------------------- write ops

  function putOptionsFromHeaders(request: FastifyRequest) {
    const h = request.headers;
    const contentType = headerStr(h['content-type']);
    const cacheControl = headerStr(h['cache-control']);
    const ifNoneMatch = headerStr(h['if-none-match']);
    const ifMatch = headerStr(h['if-match']);
    return {
      ...(contentType ? { contentType } : {}),
      ...(cacheControl ? { cacheControl } : {}),
      metadata: metadataFromHeaders(h),
      ...(ifNoneMatch === '*' ? { ifNoneMatch: '*' as const } : {}),
      ...(ifMatch ? { ifMatch } : {}),
    };
  }

  async function putObject(request: FastifyRequest, reply: FastifyReply, bucket: string, key: string, auth: AuthContext) {
    const body = decodeBody(request.raw, auth);
    if (opts.maxObjectBytes !== undefined && body.contentLength !== undefined && body.contentLength > opts.maxObjectBytes) {
      throw new HttpError(400, 'EntityTooLarge', 'Your proposed upload exceeds the maximum allowed object size.');
    }
    const md5 = contentMd5Hex(request.raw);
    const res = await adapter.put(bucket, key, body.stream, {
      ...putOptionsFromHeaders(request),
      ...(body.contentLength !== undefined ? { contentLength: body.contentLength } : {}),
      ...(md5 ? { expectedMd5: md5 } : {}),
    });
    reply.header('ETag', quote(res.etag));
    return reply.status(200).send();
  }

  async function copyObject(request: FastifyRequest, reply: FastifyReply, bucket: string, key: string, auth: AuthContext, source: string) {
    let src = source;
    const q = src.indexOf('?');
    if (q >= 0) {
      if (/versionId=(?!null\b)/.test(src.slice(q))) throw new HttpError(501, 'NotImplemented', 'Versioned copy sources are not supported');
      src = src.slice(0, q);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(src.replace(/^\//, ''));
    } catch {
      throw new HttpError(400, 'InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey');
    }
    const slash = decoded.indexOf('/');
    if (slash <= 0) throw new HttpError(400, 'InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey');
    const srcBucket = decoded.slice(0, slash);
    const srcKey = decoded.slice(slash + 1);
    validateBucketName(srcBucket);
    validateKey(srcKey);
    requireAuth(auth, srcBucket, false);
    const h = request.headers;
    const replace = headerStr(h['x-amz-metadata-directive'])?.toUpperCase() === 'REPLACE';
    const ifMatch = headerStr(h['x-amz-copy-source-if-match']);
    const sameObject = srcBucket === bucket && srcKey === key;
    if (sameObject && !replace) {
      throw new HttpError(400, 'InvalidRequest', 'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata.');
    }
    const contentType = headerStr(h['content-type']);
    const cacheControl = headerStr(h['cache-control']);
    const res = await adapter.copy(srcBucket, srcKey, bucket, key, {
      ...(replace ? { metadata: metadataFromHeaders(h) } : {}),
      ...(replace && contentType ? { contentType } : {}),
      ...(replace && cacheControl ? { cacheControl } : {}),
      ...(ifMatch ? { ifMatch } : {}),
    });
    reply.header('Content-Type', 'application/xml');
    return reply.send(xml('CopyObjectResult', { LastModified: new Date(), ETag: quote(res.etag) }));
  }

  // ---------------------------------------------------------------- bucket ops

  async function listObjects(request: FastifyRequest, reply: FastifyReply, bucket: string, q: Map<string, string>) {
    const v2 = q.get('list-type') === '2';
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? '';
    const encodeUrl = q.get('encoding-type') === 'url';
    const maxKeysRaw = q.get('max-keys');
    const maxKeys = maxKeysRaw === undefined ? 1000 : Number(maxKeysRaw);
    if (!Number.isInteger(maxKeys) || maxKeys < 0) throw new HttpError(400, 'InvalidArgument', 'max-keys must be a non-negative integer');
    const token = q.get('continuation-token');
    const startAfter = v2 ? q.get('start-after') : q.get('marker');
    const res = await adapter.list(bucket, {
      prefix,
      ...(delimiter ? { delimiter } : {}),
      maxKeys,
      ...(v2 && token ? { continuationToken: token } : {}),
      ...(startAfter ? { startAfter } : {}),
    });
    const enc = (s: string) => (encodeUrl ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
    const contents = res.objects.map((o) => ({
      Key: enc(o.key),
      LastModified: o.lastModified,
      ETag: quote(o.etag),
      Size: o.size,
      StorageClass: 'STANDARD',
    }));
    const common = res.commonPrefixes.map((p) => ({ Prefix: enc(p) }));
    reply.header('Content-Type', 'application/xml');
    if (v2) {
      return reply.send(
        xml('ListBucketResult', {
          Name: bucket,
          Prefix: enc(prefix),
          ...(delimiter ? { Delimiter: enc(delimiter) } : {}),
          MaxKeys: maxKeys,
          ...(encodeUrl ? { EncodingType: 'url' } : {}),
          KeyCount: res.keyCount,
          IsTruncated: res.isTruncated,
          ...(token ? { ContinuationToken: token } : {}),
          ...(res.nextContinuationToken ? { NextContinuationToken: res.nextContinuationToken } : {}),
          ...(startAfter ? { StartAfter: enc(startAfter) } : {}),
          Contents: contents,
          CommonPrefixes: common,
        }),
      );
    }
    const last = [...res.objects.map((o) => o.key), ...res.commonPrefixes].sort().at(-1);
    return reply.send(
      xml('ListBucketResult', {
        Name: bucket,
        Prefix: enc(prefix),
        Marker: enc(startAfter ?? ''),
        ...(delimiter ? { Delimiter: enc(delimiter) } : {}),
        MaxKeys: maxKeys,
        ...(encodeUrl ? { EncodingType: 'url' } : {}),
        IsTruncated: res.isTruncated,
        ...(res.isTruncated && last ? { NextMarker: enc(last) } : {}),
        Contents: contents,
        CommonPrefixes: common,
      }),
    );
  }

  async function deleteObjects(request: FastifyRequest, reply: FastifyReply, bucket: string) {
    const doc = await readXmlBody(request.raw);
    const del = doc.Delete as { Object?: Array<{ Key?: unknown }>; Quiet?: unknown } | undefined;
    if (!del) throw new HttpError(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.');
    const objects = del.Object ?? [];
    if (objects.length > 1000) throw new HttpError(400, 'MalformedXML', 'You can delete at most 1000 objects per request.');
    const quiet = String(del.Quiet ?? '').trim() === 'true';
    const results = await Promise.all(
      objects.map(async (o) => {
        const key = typeof o.Key === 'string' ? o.Key : String(o.Key ?? '');
        try {
          validateKey(key);
          await adapter.delete(bucket, key);
          return { ok: true as const, key };
        } catch (err) {
          const e = toS3Error(err);
          return { ok: false as const, key, code: e.code, message: e.message };
        }
      }),
    );
    reply.header('Content-Type', 'application/xml');
    return reply.send(
      xml('DeleteResult', {
        Deleted: quiet ? [] : results.filter((r) => r.ok).map((r) => ({ Key: r.key })),
        Error: results.filter((r) => !r.ok).map((r) => ({ Key: r.key, Code: (r as { code: string }).code, Message: (r as { message: string }).message })),
      }),
    );
  }

  async function bucketOp(request: FastifyRequest, reply: FastifyReply, bucket: string, auth: AuthContext | undefined, q: Map<string, string>) {
    validateBucketName(bucket);
    const m = request.method;
    const sub = (name: string) => q.has(name);
    if (m === 'GET') {
      requireAuth(auth, bucket, false);
      if (sub('location')) {
        await adapter.headBucket(bucket);
        reply.header('Content-Type', 'application/xml');
        const loc = region === 'auto' || region === 'us-east-1' ? '' : xmlEscape(region);
        return reply.send(`<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="${S3_NS}">${loc}</LocationConstraint>`);
      }
      for (const unsupported of ['uploads', 'versions', 'versioning', 'cors', 'policy', 'acl', 'lifecycle', 'tagging', 'website', 'encryption', 'object-lock', 'notification', 'logging', 'replication']) {
        if (sub(unsupported)) throw new HttpError(501, 'NotImplemented', `?${unsupported} is not implemented`);
      }
      return listObjects(request, reply, bucket, q);
    }
    if (m === 'HEAD') {
      requireAuth(auth, bucket, false);
      await adapter.headBucket(bucket);
      reply.header('x-amz-bucket-region', responseRegion);
      return reply.status(200).send();
    }
    if (m === 'PUT') {
      requireAuth(auth, bucket, true);
      if ([...q.keys()].length > 0) throw new HttpError(501, 'NotImplemented', 'Bucket configuration is not implemented');
      request.raw.resume();
      await adapter.createBucket(bucket);
      reply.header('Location', `/${bucket}`);
      return reply.status(200).send();
    }
    if (m === 'DELETE') {
      requireAuth(auth, bucket, true);
      if ([...q.keys()].length > 0) throw new HttpError(501, 'NotImplemented', 'Bucket configuration is not implemented');
      await adapter.deleteBucket(bucket);
      return reply.status(204).send();
    }
    if (m === 'POST' && sub('delete')) {
      requireAuth(auth, bucket, true);
      return deleteObjects(request, reply, bucket);
    }
    throw new HttpError(501, 'NotImplemented', 'A header or query you provided implies functionality that is not implemented');
  }

  // ---------------------------------------------------------------- object ops

  async function objectOp(request: FastifyRequest, reply: FastifyReply, bucket: string, key: string, auth: AuthContext | undefined, q: Map<string, string>) {
    validateBucketName(bucket);
    validateKey(key);
    const m = request.method;
    const uploadId = q.get('uploadId');

    if (m === 'GET' || m === 'HEAD') {
      if (uploadId !== undefined) throw new HttpError(501, 'NotImplemented', 'ListParts is not implemented');
      for (const unsupported of ['acl', 'tagging', 'torrent', 'retention', 'legal-hold', 'attributes']) {
        if (q.has(unsupported)) throw new HttpError(501, 'NotImplemented', `?${unsupported} is not implemented`);
      }
      return serveObject(request, reply, bucket, key, auth, q);
    }

    const a = requireAuth(auth, bucket, true);
    if (m === 'PUT') {
      const copySource = headerStr(request.headers['x-amz-copy-source']);
      const partNumber = q.get('partNumber');
      if (uploadId !== undefined && partNumber !== undefined) {
        if (copySource) throw new HttpError(501, 'NotImplemented', 'UploadPartCopy is not implemented');
        const body = decodeBody(request.raw, a);
        const md5 = contentMd5Hex(request.raw);
        const etag = await multipart!.uploadPart(uploadId, bucket, key, Number(partNumber), body.stream, md5);
        reply.header('ETag', quote(etag));
        return reply.status(200).send();
      }
      for (const unsupported of ['acl', 'tagging', 'retention', 'legal-hold']) {
        if (q.has(unsupported)) throw new HttpError(501, 'NotImplemented', `?${unsupported} is not implemented`);
      }
      if (copySource) return copyObject(request, reply, bucket, key, a, copySource);
      return putObject(request, reply, bucket, key, a);
    }
    if (m === 'POST') {
      if (q.has('uploads')) {
        request.raw.resume();
        const o = putOptionsFromHeaders(request);
        const id = await multipart!.create(bucket, key, o);
        reply.header('Content-Type', 'application/xml');
        return reply.send(xml('InitiateMultipartUploadResult', { Bucket: bucket, Key: key, UploadId: id }));
      }
      if (uploadId !== undefined) {
        const doc = await readXmlBody(request.raw);
        const parts = (doc.CompleteMultipartUpload?.Part ?? []) as Array<{ PartNumber?: unknown; ETag?: unknown }>;
        const list = parts.map((p) => ({ partNumber: Number(p.PartNumber), etag: String(p.ETag ?? '') }));
        const res = await multipart!.complete(uploadId, bucket, key, list);
        reply.header('Content-Type', 'application/xml');
        return reply.send(xml('CompleteMultipartUploadResult', { Location: `/${bucket}/${key}`, Bucket: bucket, Key: key, ETag: quote(res.etag) }));
      }
      throw new HttpError(501, 'NotImplemented', 'POST object uploads are not implemented; use PUT or a presigned PUT URL');
    }
    if (m === 'DELETE') {
      if (uploadId !== undefined) {
        await multipart!.abort(uploadId, bucket, key);
        return reply.status(204).send();
      }
      const ifMatch = headerStr(request.headers['if-match']);
      await adapter.delete(bucket, key, ifMatch ? { ifMatch } : {});
      return reply.status(204).send();
    }
    throw new HttpError(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.');
  }

  // ---------------------------------------------------------------- routes

  const methods = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'] as const;

  const dispatch = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
    const auth = authenticate(request);
    const q = new Map(parseQuery(splitUrl(request.raw.url ?? '/').query));
    const bucket = request.params.bucket;
    const key = request.params['*'] ?? '';
    if (key === '') return bucketOp(request, reply, bucket, auth, q);
    if (!opts.s3 && request.method !== 'GET' && request.method !== 'HEAD') {
      throw new HttpError(405, 'MethodNotAllowed', 'The S3 API is not enabled on this server');
    }
    return objectOp(request, reply, bucket, key, auth, q);
  };

  app.route<{ Params: Params }>({ method: [...methods], url: '/:bucket/*', handler: dispatch, exposeHeadRoute: false });
  app.route<{ Params: Params }>({ method: [...methods], url: '/:bucket', handler: dispatch, exposeHeadRoute: false });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      const auth = requireAuth(authenticate(request), undefined, false);
      const buckets = (await adapter.listBuckets()).filter((b) => canAccessBucket(auth, b.name));
      reply.header('Content-Type', 'application/xml');
      return reply.send(
        xml('ListAllMyBucketsResult', {
          Owner: { ID: 'drivebucket', DisplayName: 'drivebucket' },
          Buckets: { Bucket: buckets.map((b) => ({ Name: b.name, CreationDate: b.createdAt })) },
        }),
      );
    },
  });

  return server;
}
