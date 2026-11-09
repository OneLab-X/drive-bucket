import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DriveAdapter } from '../src/drive-adapter.js';
import {
  BucketAlreadyExists,
  ConfigError,
  DriveBucketError,
  InvalidKey,
  InvalidRange,
  NoSuchBucket,
  NoSuchKey,
  PreconditionFailed,
  QuotaExceeded,
} from '../src/errors.js';
import { MemoryLRUIndex } from '../src/index/memory.js';
import { keyHash } from '../src/keys.js';
import { encodeObjectProps } from '../src/metadata.js';
import { FakeDrive, httpError } from './fake-drive.js';
import { noSleep, patternBuffer, patternStream, readAll, setup } from './helpers.js';

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const KiB = 1024;
const MiB = 1024 * KiB;

async function withBucket(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  await ctx.adapter.createBucket('photos');
  return { ...ctx, store: ctx.adapter.bucket('photos') };
}

describe('root and buckets', () => {
  it('creates an app-owned root folder once and reuses it', async () => {
    const fake = new FakeDrive();
    const a1 = new DriveAdapter({ api: fake, retry: noSleep });
    const root1 = await a1.init();
    const a2 = new DriveAdapter({ api: fake, retry: noSleep });
    expect(await a2.init()).toBe(root1);
    expect(fake.count('createFile')).toBe(1);
    expect(fake.files.get(root1)!.file).toMatchObject({ name: 'drivebucket', parents: ['root'], appProperties: { drivebucket: 'root' } });
  });

  it('creates, lists, heads buckets and rejects duplicates', async () => {
    const { adapter } = setup();
    await adapter.createBucket('photos');
    await adapter.createBucket('docs');
    await expect(adapter.createBucket('photos')).rejects.toBeInstanceOf(BucketAlreadyExists);
    expect((await adapter.listBuckets()).map((b) => b.name)).toEqual(['docs', 'photos']);
    expect((await adapter.headBucket('docs')).name).toBe('docs');
    await expect(adapter.headBucket('nope')).rejects.toBeInstanceOf(NoSuchBucket);
    await expect(adapter.bucket('nope').put('k', 'x')).rejects.toBeInstanceOf(NoSuchBucket);
  });

  it('deletes only empty buckets', async () => {
    const { adapter, store } = await withBucket();
    await store.put('a', 'x');
    await expect(adapter.deleteBucket('photos')).rejects.toMatchObject({ code: 'BucketNotEmpty' });
    await store.delete('a', { permanent: true });
    await adapter.deleteBucket('photos');
    await expect(adapter.headBucket('photos')).rejects.toBeInstanceOf(NoSuchBucket);
  });

  it('uses a shared drive root and validates membership', async () => {
    const fake = new FakeDrive();
    fake.addSharedDrive('sd1');
    const adapter = new DriveAdapter({ api: fake, sharedDriveId: 'sd1', retry: noSleep });
    expect(await adapter.init()).toBe('sd1');
    const b = await adapter.createBucket('photos');
    expect(fake.files.get(b.folderId)!.file.driveId).toBe('sd1');

    const bad = new DriveAdapter({ api: fake, sharedDriveId: 'nope', retry: noSleep });
    await expect(bad.init()).rejects.toThrow(/not a shared drive/);
  });

  it('fails fast for a service account without a shared drive or subject', () => {
    const auth = { type: 'serviceAccount' as const, credentials: { client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' } };
    expect(() => new DriveAdapter({ auth })).toThrow(ConfigError);
    expect(() => new DriveAdapter({ auth })).toThrow(/no Drive storage quota/);
    expect(() => new DriveAdapter({ auth: { ...auth, subject: 'user@example.com' } })).not.toThrow();
    expect(() => new DriveAdapter({ auth, sharedDriveId: 'sd' })).not.toThrow();
  });

  it('rejects a My Drive root folder for a service account without subject', async () => {
    const fake = new FakeDrive();
    const folder = fake.seed({ name: 'r', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
    const adapter = new DriveAdapter({
      api: fake,
      retry: noSleep,
      rootFolderId: folder.id,
      auth: { type: 'serviceAccount', credentials: { client_email: 'a', private_key: 'b' } },
    });
    await expect(adapter.init()).rejects.toThrow(/service accounts have no storage quota/);
  });

  it('explains drive.file visibility when rootFolderId is not accessible', async () => {
    const { adapter } = setup({ rootFolderId: 'missing' });
    await expect(adapter.init()).rejects.toThrow(/drive\.file/);
  });
});

describe('put / get / head', () => {
  it('round-trips a small object with metadata', async () => {
    const { store, fake } = await withBucket();
    const body = Buffer.from('hello world');
    const put = await store.put('2026/cat.jpg', body, {
      contentType: 'image/jpeg',
      metadata: { Camera: 'X100' },
      cacheControl: 'public, max-age=31536000',
    });
    expect(put.etag).toBe(md5(body));
    expect(put.size).toBe(11);
    expect(fake.count('createFile')).toBe(3); // root + bucket + object (multipart)
    expect(fake.files.get(put.fileId)!.file.name).toBe('cat.jpg');

    const got = await store.get('2026/cat.jpg');
    expect(await readAll(got.stream)).toEqual(body);
    expect(got).toMatchObject({
      key: '2026/cat.jpg',
      size: 11,
      contentLength: 11,
      etag: md5(body),
      contentType: 'image/jpeg',
      metadata: { camera: 'X100' },
      cacheControl: 'public, max-age=31536000',
    });
    const head = await store.head('2026/cat.jpg');
    expect(head.lastModified).toBeInstanceOf(Date);
  });

  it('accepts string, Uint8Array and stream bodies', async () => {
    const { store } = await withBucket();
    await store.put('s', 'text');
    await store.put('u', new Uint8Array([1, 2, 3]));
    await store.put('r', patternStream(1000, 7));
    expect((await readAll((await store.get('s')).stream)).toString()).toBe('text');
    expect([...(await readAll((await store.get('u')).stream))]).toEqual([1, 2, 3]);
    expect(await readAll((await store.get('r')).stream)).toEqual(patternBuffer(1000));
  });

  it('stores an empty object', async () => {
    const { store } = await withBucket();
    const r = await store.put('empty', Buffer.alloc(0));
    expect(r.size).toBe(0);
    expect((await store.head('empty')).size).toBe(0);
  });

  it('overwrites in place, keeping the file id and clearing stale metadata', async () => {
    const { store, fake } = await withBucket();
    const a = await store.put('k', 'one', { metadata: { a: '1' } });
    const b = await store.put('k', 'two', { metadata: { b: '2' } });
    expect(b.fileId).toBe(a.fileId);
    expect(fake.count('updateFile')).toBe(1);
    const head = await store.head('k');
    expect(head.metadata).toEqual({ b: '2' });
    expect(fake.files.get(a.fileId)!.file.appProperties!['m.a']).toBeUndefined();
  });

  it('round-trips a 1024-byte key and large spilled metadata', async () => {
    const { store } = await withBucket();
    const key = 'd/'.repeat(100) + 'é'.repeat(412); // 200 + 824 = 1024 bytes
    expect(Buffer.byteLength(key)).toBe(1024);
    await store.put(key, 'x', { metadata: { description: 'y'.repeat(1500) }, cacheControl: 'c'.repeat(200) });
    const head = await store.head(key);
    expect(head.key).toBe(key);
    expect(head.metadata.description).toHaveLength(1500);
    expect(head.cacheControl).toHaveLength(200);
    // Overwriting with small metadata un-spills and clears the description.
    await store.put(key, 'x', { metadata: { a: 'b' } });
    expect((await store.head(key)).metadata).toEqual({ a: 'b' });
  });

  it('validates keys', async () => {
    const { store } = await withBucket();
    await expect(store.put('../x', 'x')).rejects.toBeInstanceOf(InvalidKey);
    await expect(store.get('a'.repeat(1025))).rejects.toBeInstanceOf(InvalidKey);
  });

  it('rejects Google Workspace content types', async () => {
    const { store } = await withBucket();
    await expect(store.put('k', 'x', { contentType: 'application/vnd.google-apps.document' })).rejects.toMatchObject({ code: 'InvalidArgument' });
  });

  it('enforces maxObjectBytes for buffers, streams and declared lengths', async () => {
    const { store } = await withBucket({ maxObjectBytes: 100 });
    await expect(store.put('a', Buffer.alloc(101))).rejects.toMatchObject({ code: 'EntityTooLarge' });
    await expect(store.put('b', patternStream(150, 10))).rejects.toMatchObject({ code: 'EntityTooLarge' });
    await expect(store.put('c', 'x', { contentLength: 1000 })).rejects.toMatchObject({ code: 'EntityTooLarge' });
    await expect(store.put('d', Buffer.alloc(100))).resolves.toBeTruthy();
  });

  it('rejects a body that does not match contentLength', async () => {
    const { store } = await withBucket();
    await expect(store.put('k', patternStream(10, 3), { contentLength: 11 })).rejects.toMatchObject({ code: 'IncompleteBody' });
  });

  it('maps storage quota errors', async () => {
    const { store, fake } = await withBucket();
    fake.failNext('createFile', httpError(403, 'storageQuotaExceeded'));
    await expect(store.put('k', 'x')).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it('throws NoSuchKey for missing objects', async () => {
    const { store } = await withBucket();
    await expect(store.get('missing')).rejects.toBeInstanceOf(NoSuchKey);
    await expect(store.head('missing')).rejects.toMatchObject({ code: 'NoSuchKey', status: 404 });
  });
});

describe('ranges', () => {
  it('serves start-end, open-ended and suffix ranges', async () => {
    const { store } = await withBucket();
    const body = patternBuffer(1000);
    await store.put('k', body);
    const r1 = await store.get('k', { range: { start: 10, end: 19 } });
    expect(r1.range).toEqual({ start: 10, end: 19, total: 1000 });
    expect(r1.contentLength).toBe(10);
    expect(await readAll(r1.stream)).toEqual(body.subarray(10, 20));
    const r2 = await store.get('k', { range: { start: 990 } });
    expect(await readAll(r2.stream)).toEqual(body.subarray(990));
    const r3 = await store.get('k', { range: { suffix: 5 } });
    expect(r3.range).toEqual({ start: 995, end: 999, total: 1000 });
    const r4 = await store.get('k', { range: { start: 0, end: 5000 } });
    expect(r4.range?.end).toBe(999);
  });

  it('rejects unsatisfiable ranges', async () => {
    const { store } = await withBucket();
    await store.put('k', patternBuffer(10));
    await expect(store.get('k', { range: { start: 10 } })).rejects.toBeInstanceOf(InvalidRange);
    await expect(store.get('k', { range: { start: 5, end: 2 } })).rejects.toBeInstanceOf(InvalidRange);
    await expect(store.get('k', { range: { suffix: 0 } })).rejects.toBeInstanceOf(InvalidRange);
  });
});

describe('resumable uploads', () => {
  const chunkSize = 256 * KiB;

  it('uses multipart at exactly 5 MiB and resumable above', async () => {
    const { store, fake } = await withBucket({ chunkSize });
    await store.put('five', patternBuffer(5 * MiB));
    expect(fake.count('startResumable')).toBe(0);
    await store.put('more', patternBuffer(5 * MiB + 1));
    expect(fake.count('startResumable')).toBe(1);
  });

  it('streams an unknown-length body in 256 KiB-aligned chunks and verifies md5', async () => {
    const { store, fake } = await withBucket({ chunkSize });
    const size = 6 * MiB + 12_345;
    const put = await store.put('big.bin', patternStream(size), { contentType: 'application/x-test' });
    expect(put.size).toBe(size);
    expect(put.etag).toBe(md5(patternBuffer(size)));
    const chunks = fake.calls.filter((c) => c.op === 'putChunk').map((c) => c.args as [string, number, number, number | undefined]);
    expect(chunks.length).toBe(Math.ceil(size / chunkSize));
    for (const [, len, , total] of chunks.slice(0, -1)) {
      expect(len % chunkSize).toBe(0);
      expect(total).toBeUndefined();
    }
    expect(chunks.at(-1)![3]).toBe(size);
    expect(await readAll((await store.get('big.bin')).stream)).toEqual(patternBuffer(size));
  });

  it('declares the total when contentLength is known and handles exact chunk multiples', async () => {
    const { store, fake } = await withBucket({ chunkSize });
    const size = 6 * MiB; // exact multiple of chunkSize
    await store.put('exact', patternStream(size), { contentLength: size });
    const chunks = fake.calls.filter((c) => c.op === 'putChunk').map((c) => c.args as [string, number, number, number | undefined]);
    expect(chunks.every(([, , , total]) => total === size)).toBe(true);
    expect(chunks.at(-1)![1]).toBeGreaterThan(0);
  });

  it('resumes after a transient chunk failure by querying the session', async () => {
    const { store, fake } = await withBucket({ chunkSize });
    fake.failNext('putChunk', httpError(503, 'backendError'));
    const size = 5 * MiB + 700 * KiB;
    const put = await store.put('k', patternBuffer(size));
    expect(fake.count('queryResumable')).toBe(1);
    expect(put.etag).toBe(md5(patternBuffer(size)));
  });

  it('resends the tail when Drive acknowledges fewer bytes than sent', async () => {
    const { store, fake } = await withBucket({ chunkSize: 1024 * KiB });
    fake.shortAckBytes = 256 * KiB;
    const size = 6 * MiB;
    const put = await store.put('k', patternBuffer(size));
    expect(put.etag).toBe(md5(patternBuffer(size)));
  });

  it('overwrites a large object in place via a resumable PATCH session', async () => {
    const { store, fake } = await withBucket({ chunkSize });
    const a = await store.put('k', 'small');
    const b = await store.put('k', patternBuffer(5 * MiB + 1));
    expect(b.fileId).toBe(a.fileId);
    const start = fake.calls.find((c) => c.op === 'startResumable')!.args[0] as { fileId?: string };
    expect(start.fileId).toBe(a.fileId);
  });

  it('rejects a chunk size that is not a multiple of 256 KiB', () => {
    expect(() => new DriveAdapter({ api: new FakeDrive(), chunkSize: 1000 })).toThrow(/256 KiB/);
  });
});

describe('key index and duplicates', () => {
  it('uses the index to skip list calls', async () => {
    const { store, fake } = await withBucket();
    await store.put('k', 'x');
    const lists = fake.count('listFiles');
    await store.head('k');
    await store.head('k');
    expect(fake.count('listFiles')).toBe(lists);
  });

  it('falls back to a list query on index miss (shared store, fresh process)', async () => {
    const { store, fake } = await withBucket();
    await store.put('k', 'x');
    const other = new DriveAdapter({ api: fake, retry: noSleep, index: new MemoryLRUIndex() }).bucket('photos');
    const before = fake.count('listFiles');
    expect((await other.head('k')).size).toBe(1);
    expect(fake.count('listFiles')).toBeGreaterThan(before);
  });

  it('re-resolves when the indexed file was deleted out of band', async () => {
    const { store, fake } = await withBucket();
    const first = await store.put('k', 'x');
    fake.files.delete(first.fileId);
    await expect(store.head('k')).rejects.toBeInstanceOf(NoSuchKey);
    await store.put('k', 'y');
    expect((await store.head('k')).size).toBe(1);
  });

  it('keeps the newest of duplicate files and trashes the others', async () => {
    const { adapter, store, fake } = await withBucket();
    const folderId = (await adapter.headBucket('photos')).folderId;
    const mk = (content: string) =>
      fake.seed(
        {
          name: 'k',
          mimeType: 'text/plain',
          parents: [folderId],
          appProperties: encodeObjectProps({ bucket: 'photos', key: 'k', metadata: {} }).appProperties as Record<string, string>,
        },
        Buffer.from(content),
      );
    const old = mk('old');
    const newer = mk('newer');
    const got = await store.get('k');
    expect((await readAll(got.stream)).toString()).toBe('newer');
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.files.get(old.id)!.file.trashed).toBe(true);
    expect(fake.files.get(newer.id)!.file.trashed).toBe(false);
  });

  it('ignores files whose kh matches but key differs (hash paranoia)', async () => {
    const { adapter, store, fake } = await withBucket();
    const folderId = (await adapter.headBucket('photos')).folderId;
    const props = encodeObjectProps({ bucket: 'photos', key: 'other', metadata: {} }).appProperties as Record<string, string>;
    fake.seed({ name: 'x', parents: [folderId], appProperties: { ...props, kh: keyHash('photos', 'k') } }, Buffer.from('x'));
    await expect(store.head('k')).rejects.toBeInstanceOf(NoSuchKey);
  });
});

describe('delete', () => {
  it('trashes by default and deletes permanently on request', async () => {
    const { store, fake } = await withBucket();
    const a = await store.put('a', 'x');
    const b = await store.put('b', 'x');
    expect(await store.delete('a')).toEqual({ deleted: true });
    expect(fake.files.get(a.fileId)!.file.trashed).toBe(true);
    await store.delete('b', { permanent: true });
    expect(fake.files.has(b.fileId)).toBe(false);
    await expect(store.head('a')).rejects.toBeInstanceOf(NoSuchKey);
  });

  it('honours the permanentDelete adapter default', async () => {
    const { store, fake } = await withBucket({ permanentDelete: true });
    const a = await store.put('a', 'x');
    await store.delete('a');
    expect(fake.files.has(a.fileId)).toBe(false);
  });

  it('is idempotent for missing keys', async () => {
    const { store } = await withBucket();
    expect(await store.delete('missing')).toEqual({ deleted: false });
  });
});

describe('conditional writes (best effort)', () => {
  it('ifNoneMatch=* only creates', async () => {
    const { store } = await withBucket();
    await store.put('k', 'x', { ifNoneMatch: '*' });
    await expect(store.put('k', 'y', { ifNoneMatch: '*' })).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('ifMatch compares quoted or unquoted etags', async () => {
    const { store } = await withBucket();
    const a = await store.put('k', 'x');
    await expect(store.put('k', 'y', { ifMatch: '"deadbeef"' })).rejects.toBeInstanceOf(PreconditionFailed);
    await store.put('k', 'y', { ifMatch: `"${a.etag}"` });
    await expect(store.delete('k', { ifMatch: a.etag })).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(store.get('k', { ifMatch: a.etag })).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(store.put('new', 'z', { ifMatch: '*' })).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('serializes concurrent writes to the same key in-process (no duplicates)', async () => {
    const { store, fake } = await withBucket();
    fake.latencyMs = 2;
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.put('k', `v${i}`)));
    const live = [...fake.files.values()].filter((f) => f.file.appProperties?.k0 === 'k' && !f.file.trashed);
    expect(live).toHaveLength(1);
    expect((await readAll((await store.get('k')).stream)).toString()).toBe('v4');
  });
});

describe('copy', () => {
  it('copies across buckets with metadata', async () => {
    const { adapter, store } = await withBucket();
    await adapter.createBucket('backup');
    await store.put('a.txt', 'hello', { contentType: 'text/plain', metadata: { x: '1' } });
    const r = await adapter.copy('photos', 'a.txt', 'backup', 'dir/a.txt');
    expect(r.etag).toBe(md5(Buffer.from('hello')));
    const head = await adapter.head('backup', 'dir/a.txt');
    expect(head).toMatchObject({ contentType: 'text/plain', metadata: { x: '1' }, size: 5 });
    expect((await store.head('a.txt')).key).toBe('a.txt');
  });

  it('replaces metadata on request and trashes an overwritten destination', async () => {
    const { store, fake } = await withBucket();
    await store.put('src', 'new', { metadata: { a: '1' } });
    const oldDst = await store.put('dst', 'old');
    const r = await store.copy('src', 'dst', { metadata: { b: '2' } });
    expect(r.fileId).not.toBe(oldDst.fileId);
    expect(fake.files.get(oldDst.fileId)!.file.trashed).toBe(true);
    const head = await store.head('dst');
    expect(head.metadata).toEqual({ b: '2' });
    expect((await readAll((await store.get('dst')).stream)).toString()).toBe('new');
  });

  it('copy onto itself updates metadata in place', async () => {
    const { store, fake } = await withBucket();
    const a = await store.put('k', 'x', { metadata: { a: '1' } });
    const r = await store.copy('k', 'k', { metadata: { b: '2' }, contentType: 'text/plain' });
    expect(r.fileId).toBe(a.fileId);
    expect(fake.count('copyFile')).toBe(0);
    expect(await store.head('k')).toMatchObject({ metadata: { b: '2' }, contentType: 'text/plain' });
  });

  it('throws NoSuchKey for a missing source', async () => {
    const { store } = await withBucket();
    await expect(store.copy('nope', 'x')).rejects.toBeInstanceOf(NoSuchKey);
  });
});

describe('list', () => {
  async function seeded() {
    const ctx = await withBucket();
    const keys = ['a.txt', 'b/1.jpg', 'b/2.jpg', 'b/c/3.jpg', 'c.txt', 'd/x', 'é.txt', 'z'];
    for (const k of keys) await ctx.store.put(k, k);
    return { ...ctx, keys };
  }

  it('lists all keys in UTF-8 byte order', async () => {
    const { store, keys } = await seeded();
    const r = await store.list();
    expect(r.objects.map((o) => o.key)).toEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    expect(r.objects.map((o) => o.key).at(-1)).toBe('é.txt');
    expect(r.isTruncated).toBe(false);
    expect(r.objects[0]).toMatchObject({ size: 5, etag: md5(Buffer.from('a.txt')) });
  });

  it('filters by prefix and groups by delimiter', async () => {
    const { store } = await seeded();
    const root = await store.list({ delimiter: '/' });
    expect(root.objects.map((o) => o.key)).toEqual(['a.txt', 'c.txt', 'z', 'é.txt']);
    expect(root.commonPrefixes).toEqual(['b/', 'd/']);
    const b = await store.list({ prefix: 'b/', delimiter: '/' });
    expect(b.objects.map((o) => o.key)).toEqual(['b/1.jpg', 'b/2.jpg']);
    expect(b.commonPrefixes).toEqual(['b/c/']);
    expect((await store.list({ prefix: 'b/' })).objects).toHaveLength(3);
  });

  it('paginates with continuation tokens, never repeating a common prefix', async () => {
    const { store } = await seeded();
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const r = await store.list({ delimiter: '/', maxKeys: 2, ...(token ? { continuationToken: token } : {}) });
      seen.push(...r.objects.map((o) => o.key), ...r.commonPrefixes);
      expect(r.keyCount).toBeLessThanOrEqual(2);
      token = r.nextContinuationToken;
      pages++;
    } while (token);
    expect(seen.sort()).toEqual(['a.txt', 'b/', 'c.txt', 'd/', 'z', 'é.txt'].sort());
    expect(pages).toBe(3);
  });

  it('supports startAfter and maxKeys=0', async () => {
    const { store } = await seeded();
    expect((await store.list({ startAfter: 'c.txt' })).objects.map((o) => o.key)).toEqual(['d/x', 'z', 'é.txt']);
    const zero = await store.list({ maxKeys: 0 });
    expect(zero.objects).toEqual([]);
    expect(zero.isTruncated).toBe(true);
  });

  it('rejects malformed tokens', async () => {
    const { store } = await seeded();
    await expect(store.list({ continuationToken: '!!!' })).rejects.toMatchObject({ code: 'InvalidArgument' });
  });

  it('pages through Drive results beyond 1000 files and ignores trashed', async () => {
    const { adapter, store, fake } = await withBucket();
    const folderId = (await adapter.headBucket('photos')).folderId;
    for (let i = 0; i < 1500; i++) {
      const key = `k${String(i).padStart(4, '0')}`;
      fake.seed(
        { name: key, parents: [folderId], appProperties: encodeObjectProps({ bucket: 'photos', key, metadata: {} }).appProperties as Record<string, string> },
        Buffer.from('x'),
      );
    }
    await store.delete('k0000');
    const all: string[] = [];
    let token: string | undefined;
    do {
      const r = await store.list({ ...(token ? { continuationToken: token } : {}) });
      all.push(...r.objects.map((o) => o.key));
      token = r.nextContinuationToken;
    } while (token);
    expect(all).toHaveLength(1499);
    expect(all[0]).toBe('k0001');
  });
});

describe('concurrency and retries', () => {
  it('never exceeds the configured parallel Drive calls', async () => {
    const { store, fake } = await withBucket({ concurrency: 3 });
    fake.latencyMs = 3;
    fake.maxInFlight = 0;
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(`k${i}`, 'x')));
    expect(fake.maxInFlight).toBeLessThanOrEqual(3);
    expect(fake.maxInFlight).toBeGreaterThan(1);
  });

  it('retries rate limits transparently and reports each attempt', async () => {
    const events: Array<{ op: string; ok: boolean; status?: number }> = [];
    const { store, fake } = await withBucket({ onDriveCall: (e) => events.push(e) });
    fake.failNext('createFile', httpError(429), 2);
    await store.put('k', 'x');
    const creates = events.filter((e) => e.op === 'files.create(multipart)');
    expect(creates.map((e) => e.ok)).toEqual([false, false, true]);
    expect(creates[0]!.status).toBe(429);
  });

  it('surfaces non-retryable errors as DriveBucketError', async () => {
    const { store, fake } = await withBucket();
    fake.failNext('getMedia', httpError(400, 'badRequest'));
    await store.put('k', 'x');
    await expect(store.get('k')).rejects.toBeInstanceOf(DriveBucketError);
  });

  it('maps a 404 on media download to NoSuchKey and evicts the index', async () => {
    const { store, fake } = await withBucket();
    await store.put('k', 'x');
    fake.failNext('getMedia', httpError(404, 'notFound'));
    await expect(store.get('k')).rejects.toBeInstanceOf(NoSuchKey);
  });
});

describe('observe()', () => {
  it('fans out call and retry events and can unsubscribe', async () => {
    const { store, fake, adapter } = await withBucket();
    const calls: string[] = [];
    const retries: Array<{ op: string; reason?: string }> = [];
    const off = adapter.observe({ onCall: (e) => calls.push(`${e.op}:${e.ok}`), onRetry: (e) => retries.push(e) });
    fake.failNext('createFile', httpError(403, 'userRateLimitExceeded'));
    await store.put('k', 'x');
    expect(calls).toContain('files.create(multipart):false');
    expect(calls).toContain('files.create(multipart):true');
    expect(retries).toEqual([expect.objectContaining({ op: 'files.create(multipart)', attempt: 1, reason: 'userRateLimitExceeded' })]);
    off();
    await store.head('k');
    expect(calls.filter((c) => c.startsWith('files.get'))).toHaveLength(0);
  });
});

describe('expectedMd5', () => {
  it('accepts a matching digest and rejects a mismatch before committing', async () => {
    const { store, fake } = await withBucket({ chunkSize: 256 * KiB });
    const body = patternBuffer(1000);
    await store.put('ok', body, { expectedMd5: md5(body).toUpperCase() });
    const before = fake.files.size;
    await expect(store.put('bad', body, { expectedMd5: md5(Buffer.from('x')) })).rejects.toMatchObject({ code: 'BadDigest', status: 400 });
    const big = patternBuffer(5 * MiB + 10);
    await expect(store.put('bad-big', patternStream(big.length), { expectedMd5: md5(Buffer.from('x')) })).rejects.toMatchObject({ code: 'BadDigest' });
    expect(fake.files.size).toBe(before);
    await expect(store.head('bad-big')).rejects.toBeInstanceOf(NoSuchKey);
  });
});

describe('createUpload (streaming, multipart backend)', () => {
  it('assembles arbitrary-sized writes into aligned chunks', async () => {
    const { adapter, fake } = await withBucket({ chunkSize: 256 * KiB });
    const up = await adapter.createUpload('photos', 'mp.bin', { contentType: 'application/x-test', metadata: { a: '1' } });
    const full = patternBuffer(1_500_000);
    const sizes = [300_001, 5, 700_000, 1, 499_993];
    let off = 0;
    for (const n of sizes) {
      await up.write(full.subarray(off, off + n));
      off += n;
    }
    expect(off).toBe(full.length);
    expect(up.bytesWritten).toBe(full.length);
    expect(await adapter.head('photos', 'mp.bin').catch((e) => e)).toBeInstanceOf(NoSuchKey);
    const res = await up.complete();
    expect(res).toMatchObject({ size: full.length, etag: md5(full) });
    const head = await adapter.head('photos', 'mp.bin');
    expect(head).toMatchObject({ contentType: 'application/x-test', metadata: { a: '1' } });
    expect(await readAll((await adapter.get('photos', 'mp.bin')).stream)).toEqual(full);
    const chunks = fake.calls.filter((c) => c.op === 'putChunk').map((c) => c.args[1] as number);
    for (const n of chunks.slice(0, -1)) expect(n % (256 * KiB)).toBe(0);
  });

  it('overwrites in place, supports empty uploads, and refuses use after complete/abort', async () => {
    const { adapter, store } = await withBucket();
    const a = await store.put('k', 'old');
    const up = await adapter.createUpload('photos', 'k');
    await up.write(Buffer.from('new'));
    expect((await up.complete()).fileId).toBe(a.fileId);
    await expect(up.write(Buffer.from('x'))).rejects.toMatchObject({ code: 'NoSuchUpload' });

    const empty = await adapter.createUpload('photos', 'empty');
    expect((await empty.complete()).size).toBe(0);

    const aborted = await adapter.createUpload('photos', 'gone');
    await aborted.write(Buffer.from('x'));
    aborted.abort();
    await expect(aborted.complete()).rejects.toMatchObject({ code: 'NoSuchUpload' });
    await expect(store.head('gone')).rejects.toBeInstanceOf(NoSuchKey);
  });

  it('lets complete() veto via check()', async () => {
    const { adapter, store } = await withBucket();
    const up = await adapter.createUpload('photos', 'k');
    await up.write(Buffer.from('abc'));
    await expect(
      up.complete(() => {
        throw new DriveBucketError('nope', { code: 'BadDigest', status: 400 });
      }),
    ).rejects.toMatchObject({ code: 'BadDigest' });
    await expect(store.head('k')).rejects.toBeInstanceOf(NoSuchKey);
  });
});

describe('stream error handling', () => {
  it('a body stream that errors before it is read rejects put() without an unhandled error', async () => {
    const { Readable } = await import('node:stream');
    const { store } = await withBucket();
    const body = new Readable({ read() {} });
    const p = store.put('k', body);
    body.destroy(new Error('client went away'));
    await expect(p).rejects.toThrow('client went away');
    await expect(store.head('k')).rejects.toBeInstanceOf(NoSuchKey);
  });
});
