import type { AddressInfo } from 'node:net';
import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive } from '@drivebucket/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let base: string;
let close: () => void;
let adapter: DriveAdapter;

beforeAll(async () => {
  adapter = new DriveAdapter({ api: new FakeDrive() });
  await adapter.createBucket('uploads');
  const server = createApp({ adapter, bucket: 'uploads', maxBytes: 1000 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close?.());

const upload = (data: string | Uint8Array, type: string, name = 'a.png') => {
  const fd = new FormData();
  fd.append('file', new Blob([data], { type }), name);
  return fetch(`${base}/upload`, { method: 'POST', body: fd });
};

describe('express + multer example', () => {
  it('streams an upload into Drive and serves it back with ranges and 304', async () => {
    const res = await upload('pretend-png-bytes', 'image/png', 'Cat.PNG');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; url: string; size: number };
    expect(body.key).toMatch(/^uploads\/[0-9a-f-]+\.png$/);
    expect(body.size).toBe(17);

    const get = await fetch(base + body.url);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('pretend-png-bytes');
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const part = await fetch(base + body.url, { headers: { range: 'bytes=0-6' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('pretend');
    const nm = await fetch(base + body.url, { headers: { 'if-none-match': get.headers.get('etag')! } });
    expect(nm.status).toBe(304);
  });

  it('rejects disallowed types, oversized files and bad keys', async () => {
    expect((await upload('<html>', 'text/html', 'x.html')).status).toBe(400);
    const big = await upload(new Uint8Array(5000), 'image/png');
    expect(big.status).toBe(413);
    const all = await adapter.list('uploads');
    expect(all.objects.every((o) => o.size <= 1000)).toBe(true);
    expect((await fetch(`${base}/files/missing.png`)).status).toBe(404);
  });
});
