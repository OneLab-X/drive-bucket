import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeResize, resizeImage, uploadFile, UploadError, type CanvasEnv } from '../src/client.js';

function fakeEnv(width: number, height: number, outType?: string): CanvasEnv & { encodes: Array<[number, number, string, number]>; closed: boolean } {
  const env = {
    encodes: [] as Array<[number, number, string, number]>,
    closed: false,
    async createImageBitmap() {
      return { width, height, close: () => (env.closed = true) };
    },
    async encode(_b: unknown, w: number, h: number, type: string, q: number) {
      env.encodes.push([w, h, type, q]);
      return new Blob([new Uint8Array(10)], { type: outType ?? type });
    },
  };
  return env;
}

afterEach(() => vi.unstubAllGlobals());

describe('computeResize', () => {
  it.each([
    [4000, 3000, 2048, 2048, 1536],
    [3000, 4000, 2048, 1536, 2048],
    [1000, 500, 2048, 1000, 500],
    [5000, 1, 100, 100, 1],
  ])('%i×%i max %i → %i×%i', (w, h, m, ew, eh) => {
    const r = computeResize(w, h, m);
    expect([r.width, r.height]).toEqual([ew, eh]);
  });
});

describe('resizeImage', () => {
  it('downscales to webp, renames the file and closes the bitmap', async () => {
    const env = fakeEnv(4000, 3000);
    const out = (await resizeImage(new File([new Uint8Array(5000)], 'IMG_1.jpeg', { type: 'image/jpeg' }), { maxEdge: 1000, quality: 0.7 }, env)) as File;
    expect(env.encodes).toEqual([[1000, 750, 'image/webp', 0.7]]);
    expect(out.name).toBe('IMG_1.webp');
    expect(out.type).toBe('image/webp');
    expect(env.closed).toBe(true);
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const env = fakeEnv(4000, 3000, 'image/png');
    await resizeImage(new File([new Uint8Array(5000)], 'a.jpg', { type: 'image/jpeg' }), { maxEdge: 1000 }, env);
    expect(env.encodes.map((e) => e[2])).toEqual(['image/webp', 'image/jpeg']);
  });

  it('leaves non-images, GIFs, small same-type images and undecodable files alone', async () => {
    const env = fakeEnv(100, 100);
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const gif = new File(['x'], 'a.gif', { type: 'image/gif' });
    const small = new File(['x'], 'a.webp', { type: 'image/webp' });
    expect(await resizeImage(pdf, { maxEdge: 10 }, env)).toBe(pdf);
    expect(await resizeImage(gif, { maxEdge: 10 }, env)).toBe(gif);
    expect(await resizeImage(small, { maxEdge: 1000 }, env)).toBe(small);
    const broken: CanvasEnv = { createImageBitmap: async () => Promise.reject(new Error('no decoder')), encode: async () => null };
    const heic = new File(['x'], 'a.heic', { type: 'image/heic' });
    expect(await resizeImage(heic, { maxEdge: 10 }, broken)).toBe(heic);
  });

  it('keeps the original when re-encoding without resizing would make it bigger', async () => {
    const env = fakeEnv(100, 100);
    const tiny = new File([new Uint8Array(5)], 'a.png', { type: 'image/png' });
    expect(await resizeImage(tiny, { maxEdge: 1000 }, env)).toBe(tiny);
  });
});

describe('uploadFile', () => {
  it('posts multipart form data and returns the first file', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const fd = init.body as FormData;
      const f = fd.get('file') as File;
      expect(f.name).toBe('a.webp');
      return new Response(JSON.stringify({ files: [{ key: 'k', url: '/api/files/k', size: f.size, etag: 'e', contentType: f.type, name: f.name }] }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await uploadFile(new File([new Uint8Array(5000)], 'a.jpg', { type: 'image/jpeg' }), { resize: { maxEdge: 100 }, endpoint: '/upload' }, fakeEnv(4000, 3000));
    expect(res).toMatchObject({ key: 'k', contentType: 'image/webp' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/upload');
  });

  it('throws UploadError with the server code', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'EntityTooLarge', message: 'too big' } }), { status: 413 }));
    const err = await uploadFile(new Blob(['x'])).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err).toMatchObject({ status: 413, code: 'EntityTooLarge' });
  });
});

describe('end to end: client → route', () => {
  it('uploadFile against createDriveRoute', async () => {
    const { DriveAdapter } = await import('@drivebucket/core');
    const { FakeDrive } = await import('@drivebucket/core/testing');
    const { createDriveRoute } = await import('../src/index.js');
    const adapter = new DriveAdapter({ api: new FakeDrive() });
    await adapter.createBucket('photos');
    const route = createDriveRoute({ adapter, bucket: 'photos' });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => route.POST(new Request(new URL(url, 'http://localhost'), init)));
    const res = await uploadFile(new File(['hello'], 'hi.txt', { type: 'text/plain' }));
    expect(res.contentType).toBe('text/plain');
    expect((await adapter.head('photos', res.key)).size).toBe(5);
  });
});
