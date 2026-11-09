/**
 * S3 compatibility: the real @aws-sdk/client-s3 talking to drivebucket-server over HTTP,
 * backed by the in-memory FakeDrive.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive } from '@drivebucket/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type DrivebucketServer } from '../src/app.js';
import { presignUrl } from '../src/s3/presign.js';

const KEY = { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-key-0123456789abcdef' };
const RO = { accessKeyId: 'AKIDREADONLY', secretAccessKey: 'readonly-secret-0123456789abcdef' };
const SCOPED = { accessKeyId: 'AKIDSCOPED', secretAccessKey: 'scoped-secret-0123456789abcdef!' };
const md5 = (b: Buffer | string) => createHash('md5').update(b).digest('hex');

let app: DrivebucketServer;
let endpoint: string;
let fake: FakeDrive;

function client(creds = KEY, extra: Record<string, unknown> = {}) {
  return new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: creds, maxAttempts: 1, ...extra });
}

async function errorOf(p: Promise<unknown>): Promise<S3ServiceException> {
  try {
    await p;
  } catch (e) {
    return e as S3ServiceException;
  }
  throw new Error('expected rejection');
}

beforeAll(async () => {
  fake = new FakeDrive();
  const adapter = new DriveAdapter({ api: fake, chunkSize: 256 * 1024, retry: { sleep: async () => {}, random: () => 0 } });
  await adapter.createBucket('photos');
  await adapter.createBucket('other');
  app = await createServer({
    adapter,
    logger: false,
    buckets: { photos: { public: true } },
    s3: {
      credentials: [KEY, { ...RO, readOnly: true }, { ...SCOPED, buckets: ['other'] }],
    },
    cors: { origins: ['https://app.example.com'] },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  endpoint = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app?.close();
});

describe('buckets', () => {
  it('create, head, list, delete', async () => {
    const s3 = client();
    await s3.send(new CreateBucketCommand({ Bucket: 'tmp-bucket' }));
    await s3.send(new HeadBucketCommand({ Bucket: 'tmp-bucket' }));
    const list = await s3.send(new ListBucketsCommand({}));
    expect(list.Buckets?.map((b) => b.Name)).toEqual(expect.arrayContaining(['photos', 'other', 'tmp-bucket']));
    expect(list.Buckets?.[0]?.CreationDate).toBeInstanceOf(Date);
    const dup = await errorOf(s3.send(new CreateBucketCommand({ Bucket: 'tmp-bucket' })));
    expect(dup.name).toBe('BucketAlreadyOwnedByYou');
    await s3.send(new DeleteBucketCommand({ Bucket: 'tmp-bucket' }));
    const gone = await errorOf(s3.send(new HeadBucketCommand({ Bucket: 'tmp-bucket' })));
    expect(gone.$metadata.httpStatusCode).toBe(404);
  });

  it('refuses to delete a non-empty bucket', async () => {
    const s3 = client();
    await s3.send(new PutObjectCommand({ Bucket: 'other', Key: 'keep', Body: 'x' }));
    const err = await errorOf(s3.send(new DeleteBucketCommand({ Bucket: 'other' })));
    expect(err.name).toBe('BucketNotEmpty');
  });
});

describe('objects', () => {
  it('PutObject / GetObject / HeadObject round-trip with metadata', async () => {
    const s3 = client();
    const body = 'hello from the aws sdk';
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: 'photos',
        Key: 'docs/hello world.txt',
        Body: body,
        ContentType: 'text/plain',
        CacheControl: 'max-age=60',
        Metadata: { author: 'ann' },
      }),
    );
    expect(put.ETag).toBe(`"${md5(body)}"`);
    const get = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'docs/hello world.txt' }));
    expect(await get.Body!.transformToString()).toBe(body);
    expect(get).toMatchObject({ ContentType: 'text/plain', CacheControl: 'max-age=60', Metadata: { author: 'ann' }, ContentLength: body.length });
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'docs/hello world.txt' }));
    expect(head.ETag).toBe(put.ETag);
    expect(head.LastModified).toBeInstanceOf(Date);
  });

  it('handles Buffer, Uint8Array, stream (aws-chunked) and empty bodies', async () => {
    const s3 = client();
    const buf = randomBytes(300_000);
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'bin/buf', Body: buf }));
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'bin/u8', Body: new Uint8Array([1, 2, 3]) }));
    const streamed = randomBytes(6 * 1024 * 1024 + 123);
    await s3.send(
      new PutObjectCommand({ Bucket: 'photos', Key: 'bin/stream', Body: Readable.from([streamed.subarray(0, 1000), streamed.subarray(1000)]), ContentLength: streamed.length }),
    );
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'bin/empty', Body: '' }));
    const read = async (Key: string) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: 'photos', Key }))).Body!.transformToByteArray());
    expect((await read('bin/buf')).equals(buf)).toBe(true);
    expect([...(await read('bin/u8'))]).toEqual([1, 2, 3]);
    expect((await read('bin/stream')).equals(streamed)).toBe(true);
    expect((await read('bin/empty')).length).toBe(0);
  });

  it('serves ranges and conditional GETs', async () => {
    const s3 = client();
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'r.txt', Body: '0123456789' }));
    const part = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'r.txt', Range: 'bytes=3-6' }));
    expect(await part.Body!.transformToString()).toBe('3456');
    expect(part.ContentRange).toBe('bytes 3-6/10');
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'r.txt' }));
    const nm = await errorOf(s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'r.txt', IfNoneMatch: head.ETag })));
    expect(nm.$metadata.httpStatusCode).toBe(304);
    const pf = await errorOf(s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'r.txt', IfMatch: '"nope"' })));
    expect(pf.$metadata.httpStatusCode).toBe(412);
  });

  it('applies response-* overrides on signed GETs', async () => {
    const s3 = client();
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'dl.txt', Body: 'x', ContentType: 'text/plain' }));
    const res = await s3.send(
      new GetObjectCommand({ Bucket: 'photos', Key: 'dl.txt', ResponseContentDisposition: 'attachment; filename="a.txt"', ResponseContentType: 'application/x-test' }),
    );
    expect(res.ContentDisposition).toBe('attachment; filename="a.txt"');
    expect(res.ContentType).toBe('application/x-test');
  });

  it('returns NoSuchKey / NoSuchBucket', async () => {
    const s3 = client();
    expect((await errorOf(s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'missing' })))).name).toBe('NoSuchKey');
    expect((await errorOf(s3.send(new ListObjectsV2Command({ Bucket: 'no-such-bucket' })))).name).toBe('NoSuchBucket');
  });

  it('DeleteObject is idempotent; DeleteObjects reports per key', async () => {
    const s3 = client();
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'del/a', Body: 'a' }));
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'del/b', Body: 'b' }));
    await s3.send(new DeleteObjectCommand({ Bucket: 'photos', Key: 'del/a' }));
    await s3.send(new DeleteObjectCommand({ Bucket: 'photos', Key: 'del/a' }));
    const res = await s3.send(
      new DeleteObjectsCommand({ Bucket: 'photos', Delete: { Objects: [{ Key: 'del/b' }, { Key: 'del/never' }, { Key: '../bad' }] } }),
    );
    expect(res.Deleted?.map((d) => d.Key).sort()).toEqual(['del/b', 'del/never']);
    expect(res.Errors?.[0]).toMatchObject({ Key: '../bad', Code: 'InvalidArgument' });
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'photos', Prefix: 'del/' }));
    expect(list.KeyCount).toBe(0);
  });

  it('CopyObject copies and replaces metadata', async () => {
    const s3 = client();
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'c/src.txt', Body: 'copy me', ContentType: 'text/plain', Metadata: { a: '1' } }));
    const copy = await s3.send(new CopyObjectCommand({ Bucket: 'other', Key: 'c/dst.txt', CopySource: 'photos/c/src.txt' }));
    expect(copy.CopyObjectResult?.ETag).toBe(`"${md5('copy me')}"`);
    const h1 = await s3.send(new HeadObjectCommand({ Bucket: 'other', Key: 'c/dst.txt' }));
    expect(h1.Metadata).toEqual({ a: '1' });
    await s3.send(
      new CopyObjectCommand({
        Bucket: 'photos',
        Key: 'c/src.txt',
        CopySource: encodeURIComponent('photos/c/src.txt'),
        MetadataDirective: 'REPLACE',
        Metadata: { b: '2' },
        ContentType: 'text/markdown',
      }),
    );
    const h2 = await s3.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'c/src.txt' }));
    expect(h2).toMatchObject({ Metadata: { b: '2' }, ContentType: 'text/markdown' });
    const self = await errorOf(s3.send(new CopyObjectCommand({ Bucket: 'photos', Key: 'c/src.txt', CopySource: 'photos/c/src.txt' })));
    expect(self.name).toBe('InvalidRequest');
  });

  it('supports keys with special characters', async () => {
    const s3 = client();
    const keys = ['sp ace/ü+plus&amp=eq?q#h.txt', "quote'paren(1)*star!.txt", 'percent%20literal.txt', 'tilde~dash-under_score.txt'];
    for (const Key of keys) await s3.send(new PutObjectCommand({ Bucket: 'other', Key, Body: Key }));
    for (const Key of keys) {
      const got = await s3.send(new GetObjectCommand({ Bucket: 'other', Key }));
      expect(await got.Body!.transformToString()).toBe(Key);
    }
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'other' }));
    expect(list.Contents?.map((c) => c.Key)).toEqual(expect.arrayContaining(keys));
  });

  it('honours Content-MD5 and If-None-Match: *', async () => {
    const s3 = client();
    const bad = await errorOf(
      s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'md5', Body: 'abc', ContentMD5: Buffer.from(md5('xyz'), 'hex').toString('base64') })),
    );
    expect(bad.name).toBe('BadDigest');
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'md5', Body: 'abc', ContentMD5: Buffer.from(md5('abc'), 'hex').toString('base64') }));
    const exists = await errorOf(s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'md5', Body: 'new', IfNoneMatch: '*' })));
    expect(exists.$metadata.httpStatusCode).toBe(412);
  });
});

describe('listing', () => {
  beforeAll(async () => {
    const s3 = client();
    for (const k of ['l/a.txt', 'l/b/1.jpg', 'l/b/2.jpg', 'l/c/3.jpg', 'l/d.txt', 'l/e.txt']) {
      await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: k, Body: k }));
    }
  });

  it('ListObjectsV2 with prefix and delimiter', async () => {
    const res = await client().send(new ListObjectsV2Command({ Bucket: 'photos', Prefix: 'l/', Delimiter: '/' }));
    expect(res.Contents?.map((c) => c.Key)).toEqual(['l/a.txt', 'l/d.txt', 'l/e.txt']);
    expect(res.CommonPrefixes?.map((p) => p.Prefix)).toEqual(['l/b/', 'l/c/']);
    expect(res.KeyCount).toBe(5);
    expect(res.Contents?.[0]).toMatchObject({ Size: 7, ETag: `"${md5('l/a.txt')}"`, StorageClass: 'STANDARD' });
  });

  it('paginates with continuation tokens', async () => {
    const s3 = client();
    const seen: string[] = [];
    let token: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({ Bucket: 'photos', Prefix: 'l/', MaxKeys: 2, ContinuationToken: token }));
      seen.push(...(res.Contents ?? []).map((c) => c.Key!));
      token = res.NextContinuationToken;
      if (token) expect(res.IsTruncated).toBe(true);
    } while (token);
    expect(seen).toEqual(['l/a.txt', 'l/b/1.jpg', 'l/b/2.jpg', 'l/c/3.jpg', 'l/d.txt', 'l/e.txt']);
  });

  it('ListObjects v1 with marker', async () => {
    const res = await client().send(new ListObjectsCommand({ Bucket: 'photos', Prefix: 'l/', Marker: 'l/c/3.jpg' }));
    expect(res.Contents?.map((c) => c.Key)).toEqual(['l/d.txt', 'l/e.txt']);
  });
});

describe('multipart', () => {
  it('low-level Create/UploadPart/Complete with out-of-order, unaligned parts', async () => {
    const s3 = client();
    const parts = [randomBytes(5 * 1024 * 1024 + 7), randomBytes(5 * 1024 * 1024 + 333), randomBytes(1234)];
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'photos', Key: 'mp/manual.bin', ContentType: 'application/x-mp', Metadata: { m: '1' } }));
    expect(UploadId).toBeTruthy();
    // Upload part 3, then 1, then 2.
    const etags: string[] = [];
    for (const n of [3, 1, 2]) {
      const r = await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/manual.bin', UploadId, PartNumber: n, Body: parts[n - 1] }));
      etags[n - 1] = r.ETag!;
      expect(r.ETag).toBe(`"${md5(parts[n - 1]!)}"`);
    }
    const head404 = await errorOf(s3.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'mp/manual.bin' })));
    expect(head404.$metadata.httpStatusCode).toBe(404);
    const done = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'photos',
        Key: 'mp/manual.bin',
        UploadId,
        MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
      }),
    );
    const full = Buffer.concat(parts);
    expect(done.ETag).toBe(`"${md5(full)}"`);
    const got = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'mp/manual.bin' }));
    expect(Buffer.from(await got.Body!.transformToByteArray()).equals(full)).toBe(true);
    expect(got).toMatchObject({ ContentType: 'application/x-mp', Metadata: { m: '1' } });
    expect(app.drivebucket.multipart!.size).toBe(0);
  });

  it('@aws-sdk/lib-storage Upload with concurrent parts', async () => {
    const data = randomBytes(17 * 1024 * 1024 + 5);
    const up = new Upload({
      client: client(),
      params: { Bucket: 'photos', Key: 'mp/lib.bin', Body: Readable.from([data]) },
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });
    await up.done();
    const got = await client().send(new GetObjectCommand({ Bucket: 'photos', Key: 'mp/lib.bin' }));
    expect(Buffer.from(await got.Body!.transformToByteArray()).equals(data)).toBe(true);
  });

  it('rejects bad part lists and aborts cleanly', async () => {
    const s3 = client();
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'photos', Key: 'mp/bad.bin' }));
    const p1 = await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/bad.bin', UploadId, PartNumber: 1, Body: 'one' }));
    const p2 = await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/bad.bin', UploadId, PartNumber: 2, Body: 'two' }));
    const order = await errorOf(
      s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'photos',
          Key: 'mp/bad.bin',
          UploadId,
          MultipartUpload: { Parts: [{ PartNumber: 2, ETag: p2.ETag }, { PartNumber: 1, ETag: p1.ETag }] },
        }),
      ),
    );
    expect(order.name).toBe('InvalidPartOrder');
    const wrongEtag = await errorOf(
      s3.send(new CompleteMultipartUploadCommand({ Bucket: 'photos', Key: 'mp/bad.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"0"' }] } })),
    );
    expect(wrongEtag.name).toBe('InvalidPart');
    await s3.send(new AbortMultipartUploadCommand({ Bucket: 'photos', Key: 'mp/bad.bin', UploadId }));
    const gone = await errorOf(s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/bad.bin', UploadId, PartNumber: 3, Body: 'x' })));
    expect(gone.name).toBe('NoSuchUpload');
    expect((await errorOf(s3.send(new HeadObjectCommand({ Bucket: 'photos', Key: 'mp/bad.bin' })))).$metadata.httpStatusCode).toBe(404);
  });

  it('a retried part replaces the earlier attempt before it is written', async () => {
    const s3 = client();
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'photos', Key: 'mp/retry.bin' }));
    // Part 2 arrives first and twice (retry); part 1 last. Only the second attempt of part 2 counts.
    await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/retry.bin', UploadId, PartNumber: 2, Body: 'BAD' }));
    const p2 = await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/retry.bin', UploadId, PartNumber: 2, Body: 'two' }));
    const p1 = await s3.send(new UploadPartCommand({ Bucket: 'photos', Key: 'mp/retry.bin', UploadId, PartNumber: 1, Body: 'one-' }));
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: 'photos',
        Key: 'mp/retry.bin',
        UploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: p1.ETag }, { PartNumber: 2, ETag: p2.ETag }] },
      }),
    );
    const got = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'mp/retry.bin' }));
    expect(await got.Body!.transformToString()).toBe('one-two');
  });
});

describe('presigned URLs', () => {
  it('SDK presigned GET and PUT work with plain fetch', async () => {
    const s3 = client();
    const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: 'photos', Key: 'pre/upload.bin', ContentType: 'image/png' }), { expiresIn: 300 });
    const body = randomBytes(1000);
    const put = await fetch(putUrl, { method: 'PUT', body, headers: { 'Content-Type': 'image/png' } });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBe(`"${md5(body)}"`);
    const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'photos', Key: 'pre/upload.bin' }), { expiresIn: 300 });
    const get = await fetch(getUrl);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true);
    expect(get.headers.get('content-type')).toBe('image/png');
  });

  it('presignUrl() helper produces URLs the server accepts, including on private buckets', async () => {
    await client().send(new PutObjectCommand({ Bucket: 'other', Key: 'private/x y.txt', Body: 'secret' }));
    const anon = await fetch(`${endpoint}/other/private/x%20y.txt`);
    expect(anon.status).toBe(403);
    const url = presignUrl({ endpoint, bucket: 'other', key: 'private/x y.txt', ...KEY, expiresIn: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret');
    const putUrl = presignUrl({ endpoint, bucket: 'other', key: 'private/new.txt', method: 'PUT', ...KEY });
    expect((await fetch(putUrl, { method: 'PUT', body: 'hi' })).status).toBe(200);
  });

  it('rejects expired, tampered and wrong-method presigned URLs', async () => {
    const past = new Date(Date.now() - 3600_000);
    const expired = presignUrl({ endpoint, bucket: 'photos', key: 'r.txt', ...KEY, expiresIn: 60, now: past });
    const r1 = await fetch(expired);
    expect(r1.status).toBe(403);
    expect(await r1.text()).toContain('Request has expired');
    const good = presignUrl({ endpoint, bucket: 'photos', key: 'r.txt', ...KEY });
    expect((await fetch(good.replace('r.txt', 'other.txt'))).status).toBe(403);
    const r3 = await fetch(good, { method: 'PUT', body: 'x' });
    expect(r3.status).toBe(403);
    expect(await r3.text()).toContain('SignatureDoesNotMatch');
  });

  it('answers CORS preflight for allowed origins only', async () => {
    const ok = await fetch(`${endpoint}/photos/pre/upload.bin`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(ok.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type');
    const bad = await fetch(`${endpoint}/photos/x`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
    expect(bad.status).toBe(403);
    const get = await fetch(`${endpoint}/photos/r.txt`, { headers: { Origin: 'https://app.example.com' } });
    expect(get.headers.get('access-control-expose-headers')).toContain('ETag');
  });
});

describe('auth', () => {
  it('rejects a wrong secret, an unknown key and a skewed clock', async () => {
    const wrong = await errorOf(client({ ...KEY, secretAccessKey: 'wrong-secret-0123456789abcdef!!' }).send(new ListBucketsCommand({})));
    expect(wrong.name).toBe('SignatureDoesNotMatch');
    const unknown = await errorOf(client({ accessKeyId: 'NOPE', secretAccessKey: 'whatever-0123456789abcdef' }).send(new ListBucketsCommand({})));
    expect(unknown.name).toBe('InvalidAccessKeyId');
    const skewed = await errorOf(client(KEY, { systemClockOffset: 20 * 60 * 1000 }).send(new ListBucketsCommand({})));
    expect(skewed.name).toBe('RequestTimeTooSkewed');
  });

  it('enforces read-only and bucket-scoped keys', async () => {
    const ro = client(RO);
    await ro.send(new GetObjectCommand({ Bucket: 'photos', Key: 'r.txt' }));
    expect((await errorOf(ro.send(new PutObjectCommand({ Bucket: 'photos', Key: 'x', Body: 'x' })))).name).toBe('AccessDenied');
    const scoped = client(SCOPED);
    await scoped.send(new PutObjectCommand({ Bucket: 'other', Key: 'scoped.txt', Body: 'x' }));
    expect((await errorOf(scoped.send(new GetObjectCommand({ Bucket: 'photos', Key: 'r.txt' })))).name).toBe('AccessDenied');
    const buckets = await scoped.send(new ListBucketsCommand({}));
    expect(buckets.Buckets?.map((b) => b.Name)).toEqual(['other']);
    expect((await errorOf(scoped.send(new CopyObjectCommand({ Bucket: 'other', Key: 'stolen', CopySource: 'photos/r.txt' })))).name).toBe('AccessDenied');
  });

  it('anonymous: public GET only; no listing or writes', async () => {
    expect((await fetch(`${endpoint}/photos/r.txt`)).status).toBe(200);
    expect((await fetch(`${endpoint}/photos?list-type=2`)).status).toBe(403);
    expect((await fetch(`${endpoint}/photos/x`, { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await fetch(`${endpoint}/photos/r.txt`, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(`${endpoint}/`)).status).toBe(403);
  });

  it('a bad signature on a public bucket is still rejected', async () => {
    const url = presignUrl({ endpoint, bucket: 'photos', key: 'r.txt', ...KEY });
    const res = await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`));
    expect(res.status).toBe(403);
  });
});
