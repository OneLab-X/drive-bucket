# Quickstart: Express

Runnable version: [`examples/express-multer`](../examples/express-multer).

```bash
npm i @drivebucket/core express multer
npx @drivebucket/cli auth login --client-id … --client-secret … > .env
```

## Adapter

```ts
import { DriveAdapter, driveOptionsFromEnv, RedisKeyIndex } from '@drivebucket/core';

export const drive = new DriveAdapter({
  ...driveOptionsFromEnv(),          // DRIVEBUCKET_* variables
  // index: new RedisKeyIndex(redis), // share the key→file-id cache across processes
});
await drive.init();                  // fail fast on bad credentials / shared drive
await drive.createBucket('uploads').catch((e) => { if (e.code !== 'BucketAlreadyOwnedByYou') throw e; });
```

## Streaming uploads with multer

multer's built-in `memoryStorage` holds the whole file in RAM and `diskStorage` writes a temp
file. A custom storage engine can pipe `file.stream` straight into Drive instead:

```ts
import multer from 'multer';
import { DriveStorage } from './drive-storage'; // ~40 lines, see the example

const upload = multer({
  storage: new DriveStorage({ adapter: drive, bucket: 'uploads' }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post('/upload', upload.single('file'), (req, res) => {
  const { key, etag, size } = req.file as any;
  res.status(201).json({ key, url: `/files/${key}` });
});
```

`file.mimetype` comes from the client. If you serve uploads from your own domain, check the
first bytes too. `@drivebucket/next` exports `sniff()`, which works anywhere.

## Serving

```ts
import { evaluateConditionals, parseRange } from '@drivebucket/core';

app.get('/files/*key', async (req, res, next) => {
  try {
    const key = [].concat(req.params.key).join('/');
    const info = await drive.head('uploads', key);
    const v = { etag: `"${info.etag}"`, lastModified: info.lastModified };
    res.set({ 'Content-Type': info.contentType, ETag: v.etag, 'Cache-Control': info.cacheControl ?? 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    if (evaluateConditionals(req.headers, v) === 'not-modified') return res.status(304).end();
    const range = parseRange(req.headers.range);
    const out = await drive.read('uploads', info, range ? { range } : {});
    if (out.range) res.status(206).set('Content-Range', `bytes ${out.range.start}-${out.range.end}/${out.range.total}`);
    res.set('Content-Length', String(out.contentLength));
    out.stream.pipe(res);
  } catch (e) { next(e); }
});
```

For public, high-traffic reads, use [`drivebucket-server` behind a CDN](docker-cloudflare.md)
instead: you get resizing, caching headers and metrics without code.

## Errors

Every error is a `DriveBucketError` with `code` and `status`, for example `NoSuchKey` (404),
`InvalidKey` (400), `PreconditionFailed` (412), `RateLimited` (503, retried 6× already),
`QuotaExceeded`, `DailyUploadLimit` or `AuthError`.
