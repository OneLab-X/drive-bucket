import { createHash } from 'node:crypto';
import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive } from '@drivebucket/core/testing';
import { describe, expect, it } from 'vitest';
import { createDriveRoute, type DriveRouteOptions } from '../src/index.js';
import { sniff } from '../src/sniff.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1bd6a8a0000000049454e44ae426082', 'hex');
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

async function setup(opts: Partial<DriveRouteOptions> = {}) {
  const fake = new FakeDrive();
  const adapter = new DriveAdapter({ api: fake, retry: { sleep: async () => {}, random: () => 0 } });
  await adapter.createBucket('photos');
  const route = createDriveRoute({ adapter, bucket: 'photos', ...opts });
  return { fake, adapter, route };
}

function form(files: Array<{ data: Buffer | string; name: string; type: string }>) {
  const fd = new FormData();
  for (const f of files) fd.append('file', new Blob([typeof f.data === 'string' ? f.data : new Uint8Array(f.data)], { type: f.type }), f.name);
  return new Request('http://localhost/api/files', { method: 'POST', body: fd });
}

const ctx = (key: string) => ({ params: Promise.resolve({ key: key.split('/') }) });

describe('POST upload', () => {
  it('streams a file to Drive and returns key + url', async () => {
    const { route, adapter } = await setup();
    const res = await route.POST(form([{ data: PNG, name: 'dot.png', type: 'image/png' }]));
    expect(res.status).toBe(201);
    const { files } = (await res.json()) as { files: Array<{ key: string; url: string; size: number; etag: string; contentType: string; name: string }> };
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.key).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(f.url).toBe(`/api/files/${f.key}`);
    expect(f).toMatchObject({ size: PNG.length, etag: md5(PNG), contentType: 'image/png', name: 'dot.png' });
    const head = await adapter.head('photos', f.key);
    expect(head).toMatchObject({ contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable', metadata: { originalname: 'dot.png' } });
  });

  it('trusts sniffed bytes over the declared type', async () => {
    const { route } = await setup({ allowedTypes: ['image/*'] });
    const html = await route.POST(form([{ data: '<!DOCTYPE html><script>alert(1)</script>', name: 'evil.png', type: 'image/png' }]));
    expect(html.status).toBe(415);
    const mislabeled = await route.POST(form([{ data: PNG, name: 'x.bin', type: 'application/octet-stream' }]));
    expect(mislabeled.status).toBe(201);
    expect(((await mislabeled.json()) as any).files[0].contentType).toBe('image/png');
  });

  it('enforces maxBytes while streaming and stores nothing', async () => {
    const { route, fake } = await setup({ maxBytes: 1000 });
    const before = fake.files.size;
    const big = Buffer.concat([PNG, Buffer.alloc(5000)]);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(big)], { type: 'image/png' }), 'big.png');
    // No content-length header path: build a streaming request.
    const req = new Request('http://localhost/api/files', { method: 'POST', body: fd });
    const res = await route.POST(req);
    expect(res.status).toBe(413);
    expect(fake.files.size).toBe(before);
  });

  it('rejects early on a huge Content-Length', async () => {
    const { route } = await setup({ maxBytes: 1000 });
    const req = new Request('http://localhost/api/files', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '999999999' },
      body: '--x--',
    });
    expect((await route.POST(req)).status).toBe(413);
  });

  it('requires auth and multipart/form-data', async () => {
    const { route } = await setup({ auth: (req) => req.headers.get('authorization') === 'Bearer ok' });
    expect((await route.POST(form([{ data: PNG, name: 'a.png', type: 'image/png' }]))).status).toBe(401);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'a.png');
    const ok = await route.POST(new Request('http://localhost/api/files', { method: 'POST', body: fd, headers: { authorization: 'Bearer ok' } }));
    expect(ok.status).toBe(201);
    const jsonBody = await route.POST(
      new Request('http://localhost/api/files', { method: 'POST', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: '{"base64":"..."}' }),
    );
    expect(jsonBody.status).toBe(415);
  });

  it('is all-or-nothing when too many files are sent', async () => {
    const { route, fake } = await setup({ maxFiles: 1 });
    const before = [...fake.files.values()].filter((f) => !f.file.trashed && f.file.appProperties?.drivebucket === 'object').length;
    const res = await route.POST(form([{ data: PNG, name: 'a.png', type: 'image/png' }, { data: PNG, name: 'b.png', type: 'image/png' }]));
    expect(res.status).toBe(413);
    const after = [...fake.files.values()].filter((f) => !f.file.trashed && f.file.appProperties?.drivebucket === 'object').length;
    expect(after).toBe(before);
  });

  it('accepts several files and custom keys / public URLs', async () => {
    const { route } = await setup({
      maxFiles: 3,
      generateKey: ({ filename }) => `custom/${filename}`,
      publicUrl: (key) => `https://cdn.example.com/photos/${key}`,
    });
    const res = await route.POST(form([{ data: PNG, name: 'a.png', type: 'image/png' }, { data: 'hello', name: 'b.txt', type: 'text/plain' }]));
    expect(res.status).toBe(201);
    const { files } = (await res.json()) as any;
    expect(files.map((f: any) => f.key).sort()).toEqual(['custom/a.png', 'custom/b.txt']);
    expect(files.find((f: any) => f.key === 'custom/a.png').url).toBe('https://cdn.example.com/photos/custom/a.png');
  });

  it('rejects generated keys that fail validation', async () => {
    const { route } = await setup({ generateKey: () => '../escape' });
    expect((await route.POST(form([{ data: PNG, name: 'a.png', type: 'image/png' }]))).status).toBe(400);
  });

  it('400 when no file part is present', async () => {
    const { route } = await setup();
    const fd = new FormData();
    fd.append('note', 'hi');
    expect((await route.POST(new Request('http://localhost/api/files', { method: 'POST', body: fd }))).status).toBe(400);
  });
});

describe('GET / HEAD serve', () => {
  it('serves with caching headers, ranges and 304s', async () => {
    const { route, adapter } = await setup();
    await adapter.put('photos', 'a/b.txt', '0123456789', { contentType: 'text/plain', cacheControl: 'public, max-age=60' });
    const res = await route.GET(new Request('http://localhost/api/files/a/b.txt'), ctx('a/b.txt'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0123456789');
    expect(res.headers.get('etag')).toBe(`"${md5(Buffer.from('0123456789'))}"`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const part = await route.GET(new Request('http://localhost/x', { headers: { range: 'bytes=2-4' } }), ctx('a/b.txt'));
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');

    const nm = await route.GET(new Request('http://localhost/x', { headers: { 'if-none-match': res.headers.get('etag')! } }), ctx('a/b.txt'));
    expect(nm.status).toBe(304);

    const bad = await route.GET(new Request('http://localhost/x', { headers: { range: 'bytes=50-' } }), ctx('a/b.txt'));
    expect(bad.status).toBe(416);

    const head = await route.HEAD(new Request('http://localhost/x', { method: 'HEAD' }), ctx('a/b.txt'));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
  });

  it('works with Next 14 style (non-Promise) params', async () => {
    const { route, adapter } = await setup();
    await adapter.put('photos', 'k', 'x');
    const res = await route.GET(new Request('http://localhost/x'), { params: { key: ['k'] } });
    expect(res.status).toBe(200);
  });

  it('404, invalid key, risky types, protected reads', async () => {
    const { route, adapter } = await setup({ protectReads: true, auth: (r) => r.headers.get('x-ok') === '1' });
    await adapter.put('photos', 'x.html', '<html>', { contentType: 'text/html' });
    const authed = (url = 'http://localhost/x') => new Request(url, { headers: { 'x-ok': '1' } });
    expect((await route.GET(authed(), ctx('missing'))).status).toBe(404);
    expect((await route.GET(authed(), { params: { key: ['a', '..', 'b'] } })).status).toBe(400);
    const html = await route.GET(authed(), ctx('x.html'));
    expect(html.headers.get('content-disposition')).toBe('attachment');
    expect((await route.GET(new Request('http://localhost/x'), ctx('x.html'))).status).toBe(401);
  });
});

describe('sniff', () => {
  it.each([
    [PNG, 'image/png'],
    [Buffer.from('ffd8ffe000104a464946', 'hex'), 'image/jpeg'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')]), 'image/avif'],
    [Buffer.from('%PDF-1.7'), 'application/pdf'],
    [Buffer.from('  <!DOCTYPE html>'), 'text/html'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), 'image/svg+xml'],
    [Buffer.from('plain text'), undefined],
  ])('%#', (bytes, want) => expect(sniff(bytes)).toBe(want));
});

describe('failure mid-upload', () => {
  it('a Drive error during upload returns 5xx and does not hang', async () => {
    const { route, fake } = await setup();
    const { httpError } = await import('@drivebucket/core/testing');
    fake.failNext('createFile', httpError(400, 'badRequest'));
    const res = await route.POST(form([{ data: PNG, name: 'a.png', type: 'image/png' }]));
    expect(res.status).toBe(500);
  });
});
