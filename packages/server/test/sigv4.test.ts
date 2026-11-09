import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive } from '@drivebucket/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type DrivebucketServer } from '../src/app.js';
import { AwsChunkedDecoder } from '../src/s3/chunked.js';
import { presignUrl } from '../src/s3/presign.js';
import {
  ALGORITHM,
  canonicalQuery,
  canonicalUri,
  chunkSignature,
  signingKey,
  verifySigV4,
  type S3Credential,
} from '../src/s3/sigv4.js';

// AWS's published examples ("Signature Calculations for the Authorization Header", "Query
// String Auth", "Signed chunked upload") all use these values.
const AWS_KEY: S3Credential = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AWS_NOW = () => Date.UTC(2013, 4, 24, 0, 0, 0);

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

describe('SigV4 against AWS reference vectors', () => {
  it('GET object with Authorization header', () => {
    const ctx = verifySigV4(
      {
        method: 'GET',
        rawUrl: '/test.txt',
        headers: {
          host: 'examplebucket.s3.amazonaws.com',
          range: 'bytes=0-9',
          'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20130524T000000Z',
          authorization:
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
        },
      },
      { credentials: [AWS_KEY], now: AWS_NOW },
    );
    expect(ctx).toMatchObject({ mode: 'header', scope: '20130524/us-east-1/s3/aws4_request' });
  });

  it('presigned GET (query auth)', () => {
    const ctx = verifySigV4(
      {
        method: 'GET',
        rawUrl:
          '/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
        headers: { host: 'examplebucket.s3.amazonaws.com' },
      },
      { credentials: [AWS_KEY], now: AWS_NOW },
    );
    expect(ctx.mode).toBe('query');
    expect(ctx.payloadHash).toBe('UNSIGNED-PAYLOAD');
  });

  it('signed chunked upload: chunk signatures and decoder', async () => {
    const amzDate = '20130524T000000Z';
    const scope = '20130524/us-east-1/s3/aws4_request';
    const key = signingKey(AWS_KEY.secretAccessKey, '20130524', 'us-east-1', 's3');
    const seed = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9';
    const c1 = Buffer.alloc(65536, 'a');
    const c2 = Buffer.alloc(1024, 'a');
    const s1 = chunkSignature({ signingKey: key, amzDate, scope }, seed, c1);
    const s2 = chunkSignature({ signingKey: key, amzDate, scope }, s1, c2);
    const s3 = chunkSignature({ signingKey: key, amzDate, scope }, s2, Buffer.alloc(0));
    expect(s1).toBe('ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648');
    expect(s2).toBe('0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497');
    expect(s3).toBe('b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9');

    const body = Buffer.concat([
      Buffer.from(`10000;chunk-signature=${s1}\r\n`),
      c1,
      Buffer.from(`\r\n400;chunk-signature=${s2}\r\n`),
      c2,
      Buffer.from(`\r\n0;chunk-signature=${s3}\r\n\r\n`),
    ]);
    const ctx = { signingKey: key, amzDate, scope, signature: seed };
    // Feed in awkward slices to exercise the parser's buffering.
    const pieces: Buffer[] = [];
    for (let i = 0; i < body.length; i += 777) pieces.push(body.subarray(i, i + 777));
    const out = await collect(Readable.from(pieces).pipe(new AwsChunkedDecoder({ signed: ctx, decodedLength: 66560 })));
    expect(out.equals(Buffer.concat([c1, c2]))).toBe(true);

    const tampered = Buffer.from(body);
    tampered[200] = 'b'.charCodeAt(0);
    await expect(collect(Readable.from([tampered]).pipe(new AwsChunkedDecoder({ signed: ctx })))).rejects.toMatchObject({ code: 'SignatureDoesNotMatch' });
  });

  it('canonicalization helpers', () => {
    expect(canonicalUri('/b/a%20b/%C3%BC+(1)')).toBe('/b/a%20b/%C3%BC%2B%281%29');
    expect(canonicalQuery([['b', '2'], ['a', 'x y'], ['a', '1'], ['uploads', '']])).toBe('a=1&a=x%20y&b=2&uploads=');
  });

  it('presignUrl matches what the verifier expects (virtual round trip)', () => {
    const url = new URL(presignUrl({ endpoint: 'http://localhost:9000', bucket: 'b1b', key: 'dir/ü x.txt', ...AWS_KEY, now: new Date(AWS_NOW()), expiresIn: 60 }));
    const ctx = verifySigV4({ method: 'GET', rawUrl: url.pathname + url.search, headers: { host: url.host } }, { credentials: [AWS_KEY], now: AWS_NOW });
    expect(ctx.credential.accessKeyId).toBe(AWS_KEY.accessKeyId);
  });

  it('rejects region mismatch when a region is pinned, and non-s3 services', () => {
    const base = {
      method: 'GET',
      rawUrl: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      },
    };
    expect(() => verifySigV4(base, { credentials: [AWS_KEY], now: AWS_NOW, region: 'eu-west-1' })).toThrow(/region/);
    expect(() => verifySigV4(base, { credentials: [AWS_KEY], now: () => AWS_NOW() + 16 * 60_000 })).toThrow(/too large/);
    const noHost = { ...base, headers: { ...base.headers, authorization: base.headers.authorization.replace('SignedHeaders=host;', 'SignedHeaders=') } };
    expect(() => verifySigV4(noHost, { credentials: [AWS_KEY], now: AWS_NOW })).toThrow(/Host must be a signed header/);
  });
});

// ---------------------------------------------------------------------------- raw requests

const KEY: S3Credential = { accessKeyId: 'AKIDRAW', secretAccessKey: 'raw-secret-0123456789abcdef' };
let app: DrivebucketServer;
let port: number;
let fake: FakeDrive;

beforeAll(async () => {
  fake = new FakeDrive();
  const adapter = new DriveAdapter({ api: fake, retry: { sleep: async () => {}, random: () => 0 } });
  await adapter.createBucket('raw');
  app = await createServer({ adapter, logger: false, s3: { credentials: [KEY] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});
afterAll(() => app?.close());

function amzNow() {
  const d = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: d, day: d.slice(0, 8) };
}

/** Sign and send a PUT by hand. `payloadHash` is what we claim; `body` is what we send. */
function signedPut(path: string, body: Buffer, payloadHash: string, extra: Record<string, string> = {}) {
  const { amzDate, day } = amzNow();
  const host = `127.0.0.1:${port}`;
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const signed = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonical = ['PUT', canonicalUri(path), '', signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const sts = [ALGORITHM, amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = signingKey(KEY.secretAccessKey, day, 'us-east-1', 's3');
  const signature = createHmac('sha256', key).update(sts).digest('hex');
  headers.authorization = `${ALGORITHM} Credential=${KEY.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  return {
    ctx: { signingKey: key, amzDate, scope, signature },
    send: (actualBody = body) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'PUT', headers: { ...headers, 'content-length': String(actualBody.length) } }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end(actualBody);
      }),
  };
}

const exists = async (key: string) => [...fake.files.values()].some((f) => f.file.appProperties?.k0 === key && !f.file.trashed);

describe('payload verification over HTTP', () => {
  it('rejects a body that does not match x-amz-content-sha256, without creating the object', async () => {
    const claimed = createHash('sha256').update('abc').digest('hex');
    const r = await signedPut('/raw/sha.txt', Buffer.from('abc'), claimed).send(Buffer.from('abd'));
    expect(r.status).toBe(400);
    expect(r.text).toContain('XAmzContentSHA256Mismatch');
    expect(await exists('sha.txt')).toBe(false);
  });

  it('accepts STREAMING-AWS4-HMAC-SHA256-PAYLOAD and rejects a forged chunk', async () => {
    const data = Buffer.from('hello signed chunks');
    const req = signedPut('/raw/chunked.txt', Buffer.alloc(0), 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', {
      'content-encoding': 'aws-chunked',
      'x-amz-decoded-content-length': String(data.length),
    });
    const s1 = chunkSignature(req.ctx, req.ctx.signature, data);
    const s2 = chunkSignature(req.ctx, s1, Buffer.alloc(0));
    const body = Buffer.concat([Buffer.from(`${data.length.toString(16)};chunk-signature=${s1}\r\n`), data, Buffer.from(`\r\n0;chunk-signature=${s2}\r\n\r\n`)]);
    expect((await req.send(body)).status).toBe(200);
    expect(await exists('chunked.txt')).toBe(true);

    const req2 = signedPut('/raw/forged.txt', Buffer.alloc(0), 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', { 'content-encoding': 'aws-chunked' });
    const forged = Buffer.concat([Buffer.from(`5;chunk-signature=${'1'.repeat(64)}\r\nhello\r\n0;chunk-signature=${'2'.repeat(64)}\r\n\r\n`)]);
    const r = await req2.send(forged);
    expect(r.status).toBe(403);
    expect(await exists('forged.txt')).toBe(false);
  });

  it('rejects a wrong CRC32 trailer with BadDigest', async () => {
    const crc32 = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
    if (!crc32) return; // Node < 20.15: trailer CRC not verifiable, nothing to test
    const data = Buffer.from('trailer body');
    const good = Buffer.alloc(4);
    good.writeUInt32BE(crc32(data) >>> 0);
    const frame = (crc: string) =>
      Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from(`\r\n0\r\nx-amz-checksum-crc32:${crc}\r\n\r\n`)]);
    const hdrs = { 'content-encoding': 'aws-chunked', 'x-amz-trailer': 'x-amz-checksum-crc32', 'x-amz-decoded-content-length': String(data.length) };
    expect((await signedPut('/raw/crc-ok', Buffer.alloc(0), 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', hdrs).send(frame(good.toString('base64')))).status).toBe(200);
    const bad = await signedPut('/raw/crc-bad', Buffer.alloc(0), 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', hdrs).send(frame('AAAAAA=='));
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('BadDigest');
    expect(await exists('crc-bad')).toBe(false);
  });

  it('rejects a truncated aws-chunked body', async () => {
    const r = await signedPut('/raw/trunc', Buffer.alloc(0), 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', {
      'content-encoding': 'aws-chunked',
      'x-amz-decoded-content-length': '10',
    }).send(Buffer.from('a\r\n0123456789\r\n'));
    expect(r.status).toBe(400);
    expect(await exists('trunc')).toBe(false);
  });
});
