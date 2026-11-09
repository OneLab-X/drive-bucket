import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { httpError } from '@drivebucket/core/testing';
import { loadConfigFromEnv } from '../src/config.js';
import { DiskResizeCache, MemoryResizeCache } from '../src/resize/cache.js';
import { makeImage, setupServer } from './helpers.js';

const md5 = (b: Buffer | string) => createHash('md5').update(b).digest('hex');
type Ctx = Awaited<ReturnType<typeof setupServer>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});
async function setup(opts: Parameters<typeof setupServer>[0] = {}) {
  ctx = await setupServer(opts);
  return ctx;
}

describe('read proxy GET/HEAD', () => {
  it('streams a public object with caching headers', async () => {
    const { app, pub } = await setup();
    await pub.put('docs/hello.txt', 'hello world', { contentType: 'text/plain' });
    const res = await app.inject({ method: 'GET', url: '/pub/docs/hello.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello world');
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': '11',
      etag: `"${md5('hello world')}"`,
      'cache-control': 'public, max-age=3600',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    });
    expect(res.headers['last-modified']).toMatch(/GMT$/);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('HEAD returns headers only', async () => {
    const { app, pub } = await setup();
    await pub.put('k', 'abc');
    const res = await app.inject({ method: 'HEAD', url: '/pub/k' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('3');
  });

  it('uses object Cache-Control over defaults', async () => {
    const { app, pub } = await setup({ defaultCacheControl: 'public, max-age=60' });
    await pub.put('a', 'x', { cacheControl: 'public, max-age=31536000, immutable' });
    await pub.put('b', 'x');
    expect((await app.inject('/pub/a')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject('/pub/b')).headers['cache-control']).toBe('public, max-age=60');
  });

  it('decodes URL-encoded keys including unicode and spaces', async () => {
    const { app, pub } = await setup();
    await pub.put('a b/ü ñ.txt', 'ok');
    const res = await app.inject(`/pub/${encodeURIComponent('a b')}/${encodeURIComponent('ü ñ.txt')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('serves risky types as attachments and never inline HTML', async () => {
    const { app, pub } = await setup();
    await pub.put('x.html', '<script>alert(1)</script>', { contentType: 'text/html' });
    await pub.put('x.svg', '<svg/>', { contentType: 'image/svg+xml' });
    const html = await app.inject('/pub/x.html');
    expect(html.headers['content-disposition']).toBe('attachment');
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect((await app.inject('/pub/x.svg')).headers['content-disposition']).toBe('attachment');
  });

  it('hides metadata unless exposeMetadata', async () => {
    const a = await setup();
    await a.pub.put('k', 'x', { metadata: { owner: 'ann' } });
    expect((await a.app.inject('/pub/k')).headers['x-amz-meta-owner']).toBeUndefined();
    await a.app.close();
    const b = await setup({ exposeMetadata: true });
    await b.pub.put('k', 'x', { metadata: { owner: 'ann' } });
    expect((await b.app.inject('/pub/k')).headers['x-amz-meta-owner']).toBe('ann');
  });
});

describe('errors and access', () => {
  it('returns S3 XML NoSuchKey / NoSuchBucket', async () => {
    const { app } = await setup();
    const r1 = await app.inject('/pub/missing.txt');
    expect(r1.statusCode).toBe(404);
    expect(r1.headers['content-type']).toBe('application/xml');
    expect(r1.body).toContain('<Code>NoSuchKey</Code>');
    expect(r1.body).toContain('<Resource>/pub/missing.txt</Resource>');
    expect(r1.headers['x-amz-request-id']).toBeTruthy();
    const r2 = await app.inject({ method: 'HEAD', url: '/pub/missing.txt' });
    expect(r2.statusCode).toBe(404);
    expect(r2.body).toBe('');
  });

  it('NoSuchBucket only for public buckets; private/unknown buckets do not reveal existence', async () => {
    const { app } = await setup({ buckets: { pub: { public: true }, ghost: { public: true } } });
    expect((await app.inject('/ghost/x')).body).toContain('<Code>NoSuchBucket</Code>');
    expect((await app.inject('/unknown/x')).statusCode).toBe(403);
  });

  it('denies private buckets unless authorize() allows', async () => {
    const a = await setup();
    await a.priv.put('secret', 'x');
    const denied = await a.app.inject('/priv/secret');
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain('<Code>AccessDenied</Code>');
    await a.app.close();
    const b = await setup({ authorize: ({ request }) => request.headers['x-token'] === 'ok' });
    await b.priv.put('secret', 'x');
    expect((await b.app.inject({ url: '/priv/secret', headers: { 'x-token': 'ok' } })).statusCode).toBe(200);
    const res = await b.app.inject({ url: '/priv/secret', headers: { 'x-token': 'ok' } });
    expect(res.headers['cache-control']).toBe('private, max-age=0');
    expect((await b.app.inject({ url: '/priv/secret', headers: { 'x-token': 'no' } })).statusCode).toBe(403);
  });

  it('rejects invalid keys and bucket names', async () => {
    const { app } = await setup();
    // inject() normalizes dot segments like a browser; validateKey covers raw sockets (core tests).
    const r = await app.inject('/pub/a%00b');
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('InvalidArgument');
    expect((await app.inject(`/pub/${'k'.repeat(1025)}`)).statusCode).toBe(400);
    expect((await app.inject('/Bad_Bucket/x')).statusCode).toBe(400);
    // Bucket-level GET is ListObjects: never anonymous, even for public buckets.
    expect((await app.inject('/pub/')).statusCode).toBe(403);
  });

  it('maps Drive rate limiting to 503 SlowDown with Retry-After', async () => {
    const { app, pub, fake } = await setup();
    await pub.put('k', 'x');
    fake.failNext('getMedia', httpError(403, 'userRateLimitExceeded'), 6);
    const res = await app.inject('/pub/k');
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('<Code>SlowDown</Code>');
    expect(res.headers['retry-after']).toBe('1');
  });

  it('hides internal error details', async () => {
    const { app, pub, fake } = await setup();
    await pub.put('k', 'x');
    fake.failNext('getMedia', httpError(400, 'badRequest', { message: 'internal detail token=abc' }));
    const res = await app.inject('/pub/k');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('token=abc');
  });
});

describe('ranges', () => {
  it('serves 206 partial content', async () => {
    const { app, pub } = await setup();
    await pub.put('k', '0123456789');
    const r = await app.inject({ url: '/pub/k', headers: { range: 'bytes=2-5' } });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe('2345');
    expect(r.headers['content-range']).toBe('bytes 2-5/10');
    expect(r.headers['content-length']).toBe('4');
    const s = await app.inject({ url: '/pub/k', headers: { range: 'bytes=-3' } });
    expect(s.body).toBe('789');
    const h = await app.inject({ method: 'HEAD', url: '/pub/k', headers: { range: 'bytes=8-' } });
    expect(h.statusCode).toBe(206);
    expect(h.headers['content-range']).toBe('bytes 8-9/10');
  });

  it('answers 416 with Content-Range */size without downloading', async () => {
    const { app, pub, fake } = await setup();
    await pub.put('k', '0123456789');
    const before = fake.count('getMedia');
    const r = await app.inject({ url: '/pub/k', headers: { range: 'bytes=10-' } });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
    expect(fake.count('getMedia')).toBe(before);
  });

  it('ignores multi-range and stale If-Range', async () => {
    const { app, pub } = await setup();
    await pub.put('k', '0123456789');
    expect((await app.inject({ url: '/pub/k', headers: { range: 'bytes=0-1,4-5' } })).statusCode).toBe(200);
    const r = await app.inject({ url: '/pub/k', headers: { range: 'bytes=0-1', 'if-range': '"stale"' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('0123456789');
  });
});

describe('conditional requests', () => {
  it('304 on matching If-None-Match without downloading content', async () => {
    const { app, pub, fake } = await setup();
    await pub.put('k', 'abc');
    const first = await app.inject('/pub/k');
    const before = fake.count('getMedia');
    const r = await app.inject({ url: '/pub/k', headers: { 'if-none-match': first.headers.etag as string } });
    expect(r.statusCode).toBe(304);
    expect(r.body).toBe('');
    expect(r.headers.etag).toBe(first.headers.etag);
    expect(fake.count('getMedia')).toBe(before);
  });

  it('304 on If-Modified-Since, 412 on If-Match mismatch', async () => {
    const { app, pub } = await setup();
    await pub.put('k', 'abc');
    const first = await app.inject('/pub/k');
    expect((await app.inject({ url: '/pub/k', headers: { 'if-modified-since': first.headers['last-modified'] as string } })).statusCode).toBe(304);
    const r = await app.inject({ url: '/pub/k', headers: { 'if-match': '"nope"' } });
    expect(r.statusCode).toBe(412);
    expect(r.body).toContain('PreconditionFailed');
  });
});

describe('image resize', () => {
  it('resizes to webp and caches the variant', async () => {
    const { app, pub, fake, cache } = await setup();
    await pub.put('cat.png', await makeImage(400, 300), { contentType: 'image/png' });
    const r = await app.inject('/pub/cat.png?w=100&format=webp&q=70');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    const meta = await sharp(r.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 100, height: 75 });
    expect(r.headers.etag).toMatch(/^"[a-f0-9]{32}-[a-f0-9]{16}"$/);

    const downloads = fake.count('getMedia');
    const again = await app.inject('/pub/cat.png?w=100&format=webp&q=70');
    expect(again.rawPayload.equals(r.rawPayload)).toBe(true);
    expect(fake.count('getMedia')).toBe(downloads);
    expect(cache).toBeInstanceOf(MemoryResizeCache);

    const nm = await app.inject({ url: '/pub/cat.png?w=100&format=webp&q=70', headers: { 'if-none-match': r.headers.etag as string } });
    expect(nm.statusCode).toBe(304);
  });

  it('keeps the source format by default, never enlarges, and negotiates format=auto', async () => {
    const { app, pub } = await setup();
    await pub.put('a.jpg', await makeImage(200, 100, 'jpeg'), { contentType: 'image/jpeg' });
    const r = await app.inject('/pub/a.jpg?w=1000');
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(r.rawPayload).metadata()).width).toBe(200);
    const auto = await app.inject({ url: '/pub/a.jpg?w=50&format=auto', headers: { accept: 'image/avif,image/webp,*/*' } });
    expect(auto.headers['content-type']).toBe('image/avif');
    expect(auto.headers.vary).toBe('Accept');
    const plain = await app.inject({ url: '/pub/a.jpg?w=50&format=auto', headers: { accept: '*/*' } });
    expect(plain.headers['content-type']).toBe('image/jpeg');
  });

  it('invalidates variants when the source changes', async () => {
    const { app, pub } = await setup();
    await pub.put('a.png', await makeImage(100, 100), { contentType: 'image/png' });
    const e1 = (await app.inject('/pub/a.png?w=10')).headers.etag;
    await pub.put('a.png', await makeImage(120, 100), { contentType: 'image/png' });
    const e2 = (await app.inject('/pub/a.png?w=10')).headers.etag;
    expect(e1).not.toBe(e2);
  });

  it.each([
    ['w=0', 'between'],
    ['w=abc', 'integer'],
    ['w=99999', 'between'],
    ['q=101', 'between'],
    ['fit=stretch', 'fit'],
    ['format=gif', 'format'],
  ])('rejects %s', async (qs, msg) => {
    const { app, pub } = await setup();
    await pub.put('a.png', await makeImage(10, 10), { contentType: 'image/png' });
    const r = await app.inject(`/pub/a.png?${qs}`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain(msg);
  });

  it('enforces allowedWidths, source size and image types', async () => {
    const { app, pub } = await setup({ resize: { allowedWidths: [320, 640], maxSourceBytes: 1000, cache: new MemoryResizeCache() } });
    await pub.put('big.png', await makeImage(800, 800), { contentType: 'image/png' });
    await pub.put('t.txt', 'x', { contentType: 'text/plain' });
    expect((await app.inject('/pub/big.png?w=100')).statusCode).toBe(400);
    expect((await app.inject('/pub/big.png?w=320')).statusCode).toBe(413);
    expect((await app.inject('/pub/t.txt?w=320')).statusCode).toBe(400);
  });

  it('returns 422 for corrupt images', async () => {
    const { app, pub } = await setup();
    await pub.put('bad.png', 'not an image', { contentType: 'image/png' });
    const r = await app.inject('/pub/bad.png?w=10');
    expect(r.statusCode).toBe(422);
  });

  it('serves the original when resize is disabled', async () => {
    const { app, pub } = await setup({ resize: false });
    const img = await makeImage(50, 50);
    await pub.put('a.png', img, { contentType: 'image/png' });
    const r = await app.inject('/pub/a.png?w=10');
    expect(r.rawPayload.equals(img)).toBe(true);
  });

  it('collapses concurrent identical resize requests into one job', async () => {
    const { app, pub, fake } = await setup({ resize: {} });
    await pub.put('a.png', await makeImage(300, 300), { contentType: 'image/png' });
    const before = fake.count('getMedia');
    const rs = await Promise.all(Array.from({ length: 5 }, () => app.inject('/pub/a.png?w=50')));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(fake.count('getMedia') - before).toBe(1);
  });
});

describe('resize caches', () => {
  it('DiskResizeCache round-trips, survives restart and evicts LRU', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbcache-'));
    try {
      const k = (n: number) => n.toString(16).padStart(64, '0');
      const c = new DiskResizeCache({ dir, maxBytes: 3000 });
      await c.set(k(1), { body: Buffer.alloc(1000, 1), contentType: 'image/webp' });
      expect(await c.get(k(1))).toEqual({ body: Buffer.alloc(1000, 1), contentType: 'image/webp' });
      const reopened = new DiskResizeCache({ dir, maxBytes: 3000 });
      expect((await reopened.get(k(1)))?.contentType).toBe('image/webp');
      await new Promise((r) => setTimeout(r, 5));
      await reopened.set(k(2), { body: Buffer.alloc(1000), contentType: 'a/b' });
      await new Promise((r) => setTimeout(r, 5));
      await reopened.get(k(1)); // touch 1 so 2 is oldest
      await reopened.set(k(3), { body: Buffer.alloc(1000), contentType: 'a/b' });
      expect(await reopened.get(k(2))).toBeUndefined();
      expect(await reopened.get(k(1))).toBeDefined();
      expect(await reopened.size()).toBeLessThanOrEqual(3000);
      await expect(reopened.get('../../etc/passwd')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('MemoryResizeCache evicts by bytes', async () => {
    const c = new MemoryResizeCache(100);
    await c.set('a', { body: Buffer.alloc(60), contentType: 'x' });
    await c.set('b', { body: Buffer.alloc(60), contentType: 'x' });
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('b')).toBeDefined();
  });
});

describe('health and metrics', () => {
  it('exposes health, readiness and Prometheus metrics', async () => {
    const { app, pub } = await setup();
    expect((await app.inject('/-/healthy')).json()).toEqual({ ok: true });
    expect((await app.inject('/-/ready')).statusCode).toBe(200);
    await pub.put('a.png', await makeImage(20, 20), { contentType: 'image/png' });
    await app.inject('/pub/a.png');
    await app.inject('/pub/a.png?w=10');
    await app.inject('/pub/a.png?w=10');
    const m = await app.inject('/-/metrics');
    expect(m.statusCode).toBe(200);
    expect(m.body).toMatch(/drivebucket_http_requests_total\{method="GET",route="\/:bucket\/\*",status="200"\} 3/);
    expect(m.body).toMatch(/drivebucket_drive_api_calls_total\{op="files.get\(media\)",outcome="ok"\} 2/);
    expect(m.body).toMatch(/drivebucket_resize_cache_requests_total\{result="hit"\} 1/);
    expect(m.body).toMatch(/drivebucket_resize_cache_requests_total\{result="miss"\} 1/);
    expect(m.body).toContain('drivebucket_process_cpu');
  });

  it('counts retries', async () => {
    const { app, pub, fake } = await setup();
    await pub.put('k', 'x');
    fake.failNext('getMedia', httpError(429), 1);
    expect((await app.inject('/pub/k')).statusCode).toBe(200);
    expect((await app.inject('/-/metrics')).body).toMatch(/drivebucket_drive_api_retries_total\{op="files.get\(media\)",reason="unknown"\} 1/);
  });

  it('readiness fails when Drive config is broken', async () => {
    const { DriveAdapter } = await import('@drivebucket/core');
    const { FakeDrive } = await import('@drivebucket/core/testing');
    const { createServer } = await import('../src/app.js');
    const app = await createServer({ adapter: new DriveAdapter({ api: new FakeDrive(), sharedDriveId: 'nope' }), logger: false, metrics: false });
    const r = await app.inject('/-/ready');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false, error: 'InternalError' });
    await app.close();
  });
});

describe('loadConfigFromEnv', () => {
  const oauth = { DRIVEBUCKET_CLIENT_ID: 'id', DRIVEBUCKET_CLIENT_SECRET: 'sek', DRIVEBUCKET_REFRESH_TOKEN: 'rt' };

  it('parses a full OAuth config', () => {
    const c = loadConfigFromEnv({
      ...oauth,
      DRIVEBUCKET_PUBLIC_BUCKETS: 'photos, avatars',
      DRIVEBUCKET_RESIZE_WIDTHS: '320,640',
      DRIVEBUCKET_RESIZE_CACHE_DIR: '/cache',
      PORT: '9000',
      DRIVEBUCKET_TRUST_PROXY: 'true',
    });
    expect(c.adapter.auth).toEqual({ type: 'oauthRefreshToken', clientId: 'id', clientSecret: 'sek', refreshToken: 'rt' });
    expect(c.buckets).toEqual({ photos: { public: true }, avatars: { public: true } });
    expect(c.resize).toEqual({ allowedWidths: [320, 640], cacheDir: '/cache', cacheMaxBytes: 1024 * 1024 * 1024 });
    expect(c).toMatchObject({ port: 9000, trustProxy: true, host: '0.0.0.0' });
  });

  it('reports missing variables without echoing secrets', () => {
    expect(() => loadConfigFromEnv({})).toThrow(/No Google credentials/);
    expect(() => loadConfigFromEnv({ DRIVEBUCKET_CLIENT_ID: 'id', DRIVEBUCKET_CLIENT_SECRET: 'topsecret' })).toThrow(/Missing DRIVEBUCKET_REFRESH_TOKEN/);
    try {
      loadConfigFromEnv({ DRIVEBUCKET_SA_KEY_JSON: '{"private_key":"-----BEGIN PRIVATE KEY-----abc"' });
    } catch (e) {
      expect((e as Error).message).not.toContain('PRIVATE KEY');
    }
  });

  it('parses S3 credentials, CORS and size limits without echoing secrets', () => {
    const c = loadConfigFromEnv({
      ...oauth,
      DRIVEBUCKET_S3_ACCESS_KEY_ID: 'AKIDMAIN',
      DRIVEBUCKET_S3_SECRET_ACCESS_KEY: 'main-secret-0123456789',
      DRIVEBUCKET_S3_CREDENTIALS: JSON.stringify([{ accessKeyId: 'AKIDRO', secretAccessKey: 'ro-secret-0123456789ab', buckets: ['photos'], readOnly: true }]),
      DRIVEBUCKET_CORS_ORIGINS: 'https://a.example, https://b.example',
      DRIVEBUCKET_MAX_OBJECT_MB: '100',
    });
    expect(c.s3?.credentials).toEqual([
      { accessKeyId: 'AKIDRO', secretAccessKey: 'ro-secret-0123456789ab', buckets: ['photos'], readOnly: true },
      { accessKeyId: 'AKIDMAIN', secretAccessKey: 'main-secret-0123456789' },
    ]);
    expect(c.s3?.region).toBe('auto');
    expect(c.cors).toEqual({ origins: ['https://a.example', 'https://b.example'] });
    expect(c.maxObjectBytes).toBe(100 * 1024 * 1024);
    expect(c.adapter.maxObjectBytes).toBe(100 * 1024 * 1024);
    expect(loadConfigFromEnv(oauth).s3).toBeUndefined();
    const err = (() => {
      try {
        loadConfigFromEnv({ ...oauth, DRIVEBUCKET_S3_ACCESS_KEY_ID: 'AKID', DRIVEBUCKET_S3_SECRET_ACCESS_KEY: 'shortpw' });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/too short/);
    expect(err?.message).not.toContain('shortpw');
    expect(() => loadConfigFromEnv({ ...oauth, DRIVEBUCKET_S3_ACCESS_KEY_ID: 'AKID' })).toThrow(/both/);
    expect(() => loadConfigFromEnv({ ...oauth, DRIVEBUCKET_S3_CREDENTIALS: '{' })).toThrow(/JSON array/);
  });

  it('parses service-account JSON and validates numbers', () => {
    const c = loadConfigFromEnv({
      DRIVEBUCKET_SA_KEY_JSON: JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'k' }),
      DRIVEBUCKET_SHARED_DRIVE_ID: 'sd',
      DRIVEBUCKET_RESIZE: 'off',
    });
    expect(c.adapter).toMatchObject({ sharedDriveId: 'sd', auth: { type: 'serviceAccount' } });
    expect(c.resize).toBe(false);
    expect(() => loadConfigFromEnv({ ...oauth, DRIVEBUCKET_CONCURRENCY: '0' })).toThrow(/positive integer/);
    expect(() => loadConfigFromEnv({ ...oauth, DRIVEBUCKET_SCOPE: 'drive.readonly' })).toThrow(/DRIVEBUCKET_SCOPE/);
  });
});

describe('over a real socket', () => {
  it('rejects raw dot-segment keys and streams large bodies', async () => {
    const { request } = await import('node:http');
    const { app, pub } = await setup();
    const big = Buffer.alloc(6 * 1024 * 1024 + 7, 7);
    await pub.put('big.bin', big);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
        });
        req.on('error', reject);
        req.end();
      });
    const trav = await get('/pub/a/../b');
    expect(trav.status).toBe(400);
    expect(trav.body.toString()).toContain('InvalidArgument');
    const ok = await get('/pub/big.bin');
    expect(ok.status).toBe(200);
    expect(ok.body.equals(big)).toBe(true);
  });
});
