/**
 * Real-Drive integration suite. Opt in:
 *   DRIVEBUCKET_IT=1 DRIVEBUCKET_CLIENT_ID=... DRIVEBUCKET_CLIENT_SECRET=... DRIVEBUCKET_REFRESH_TOKEN=... pnpm test:it
 * Creates a throwaway bucket under the app's root folder and deletes everything it made.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriveAdapter } from '../../src/drive-adapter.js';
import { NoSuchKey } from '../../src/errors.js';

const enabled = process.env.DRIVEBUCKET_IT === '1';
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

describe.skipIf(!enabled)('DriveAdapter against real Google Drive', () => {
  const bucket = `it-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  let adapter: DriveAdapter;

  beforeAll(async () => {
    adapter = new DriveAdapter({
      auth: {
        type: 'oauthRefreshToken',
        clientId: process.env.DRIVEBUCKET_CLIENT_ID ?? '',
        clientSecret: process.env.DRIVEBUCKET_CLIENT_SECRET ?? '',
        refreshToken: process.env.DRIVEBUCKET_REFRESH_TOKEN ?? '',
      },
      ...(process.env.DRIVEBUCKET_ROOT_FOLDER_ID ? { rootFolderId: process.env.DRIVEBUCKET_ROOT_FOLDER_ID } : {}),
      permanentDelete: true,
      chunkSize: 256 * 1024,
    });
    await adapter.init();
    await adapter.createBucket(bucket);
  });

  afterAll(async () => {
    if (!adapter) return;
    const res = await adapter.list(bucket);
    for (const o of res.objects) await adapter.delete(bucket, o.key, { permanent: true });
    await adapter.deleteBucket(bucket).catch(() => undefined);
  });

  it('put/get/head small object with metadata', async () => {
    const body = Buffer.from('hello drive');
    const put = await adapter.put(bucket, 'a/hello.txt', body, { contentType: 'text/plain', metadata: { k: 'v' }, cacheControl: 'max-age=60' });
    expect(put.etag).toBe(md5(body));
    const got = await adapter.get(bucket, 'a/hello.txt');
    expect(await readAll(got.stream)).toEqual(body);
    expect(got.metadata).toEqual({ k: 'v' });
    expect(got.cacheControl).toBe('max-age=60');
    const range = await adapter.get(bucket, 'a/hello.txt', { range: { start: 6, end: 10 } });
    expect((await readAll(range.stream)).toString()).toBe('drive');
  });

  it('resumable upload > 5 MB and overwrite keeps id', async () => {
    const body = randomBytes(5 * 1024 * 1024 + 300_000);
    const first = await adapter.put(bucket, 'big.bin', body);
    expect(first.etag).toBe(md5(body));
    const second = await adapter.put(bucket, 'big.bin', Buffer.from('small now'));
    expect(second.fileId).toBe(first.fileId);
  });

  it('list with delimiter, copy, delete', async () => {
    await adapter.put(bucket, 'a/b/c.txt', 'x');
    const ls = await adapter.list(bucket, { prefix: 'a/', delimiter: '/' });
    expect(ls.objects.map((o) => o.key)).toContain('a/hello.txt');
    expect(ls.commonPrefixes).toContain('a/b/');
    await adapter.copy(bucket, 'a/hello.txt', bucket, 'copy.txt');
    expect((await adapter.head(bucket, 'copy.txt')).size).toBe(11);
    await adapter.delete(bucket, 'copy.txt');
    await expect(adapter.head(bucket, 'copy.txt')).rejects.toBeInstanceOf(NoSuchKey);
  });

  it('long multibyte key', async () => {
    const key = 'k/'.repeat(50) + 'ü'.repeat(400);
    await adapter.put(bucket, key, 'x');
    expect((await adapter.head(bucket, key)).key).toBe(key);
  });
});
