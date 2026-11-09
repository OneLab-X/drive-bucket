# @drivebucket/server

HTTP server for drivebucket:

- **S3-compatible API** (path-style, SigV4, presigned URLs, multipart) so `@aws-sdk/client-s3`
  works by changing `endpoint`.
- **Read proxy** for public buckets with caching headers, byte ranges and optional image
  resizing. Designed to sit **behind a CDN**.

Files stay private in Drive. Reads stream through the Drive API, never through
`drive.google.com`, `lh3` or `uc?export` hotlinks.

## Run

```bash
docker build -t drivebucket .
docker run -p 8080:8080 --env-file .env drivebucket
# or: cp docker-compose.example.yml docker-compose.yml && docker compose up -d
```

Without Docker: `pnpm --filter @drivebucket/server build && node packages/server/dist/bin.js`.
Startup checks credentials and the shared drive / root folder, and exits non-zero with a
readable message if they're wrong.

## S3 API

```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'https://files.example.com',
  region: 'us-east-1',          // any region is accepted unless DRIVEBUCKET_S3_REGION pins one
  forcePathStyle: true,         // required: virtual-hosted buckets are not supported
  credentials: { accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET! },
});
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'a.jpg', Body: buf, ContentType: 'image/jpeg' }));
```

| Operation | Notes |
|---|---|
| ListBuckets, CreateBucket, HeadBucket, DeleteBucket, GetBucketLocation | Delete only when empty. |
| PutObject | `Content-MD5`, `If-None-Match: *`, `If-Match`, `x-amz-meta-*`, `Cache-Control`. |
| GetObject, HeadObject | Range, conditionals, `response-content-*` overrides. |
| DeleteObject, DeleteObjects | Up to 1000 keys per DeleteObjects call. Trash by default (`DRIVEBUCKET_PERMANENT_DELETE`). |
| CopyObject | `x-amz-metadata-directive` COPY/REPLACE, `x-amz-copy-source-if-match`. |
| ListObjectsV2, ListObjects (v1) | prefix, delimiter, max-keys, continuation-token/marker, start-after, `encoding-type=url`. |
| Create/UploadPart/Complete/AbortMultipartUpload | See below. Works with `@aws-sdk/lib-storage` `Upload`. |
| Presigned GET/PUT/HEAD/DELETE | From `@aws-sdk/s3-request-presigner`, or `presignUrl()` exported here. |

**Auth.** Requests are verified with AWS Signature V4 using header auth or presigned query auth, with
15-minute clock skew and up to 7-day expiry. Payloads are checked too: signed SHA-256, signed
aws-chunked streams, and unsigned aws-chunked streams with CRC32/SHA-1/SHA-256 trailers (the AWS
SDK default since 2025). A body that fails verification is rejected before anything is
committed in Drive. Keys can be limited to some buckets (`buckets`) and/or made `readOnly`.
Requests without a signature can only GET/HEAD objects in public buckets: no listing, no writes.

**Multipart.** All parts of one upload feed a single Drive resumable session. Parts are written
to a temp dir as they arrive (in any order, concurrently) and fed to Drive strictly in order.
Restrictions compared to S3:
- Complete must list exactly parts 1..N with no gaps.
- A part that has already been written to Drive can't be replaced. Re-sending identical
  bytes is accepted.
- The returned ETag is the MD5 of the whole object, not S3's `md5-of-md5s-N`, so it matches
  later HEAD/GET responses.
- Upload state lives in the process. Run one replica, or use sticky routing per upload.
  Uploads idle for 24 hours are aborted.
- No minimum part size is enforced.

**Not implemented** (they return `501 NotImplemented`): versioning, ACLs and bucket policies, tagging, object lock,
UploadPartCopy, ListParts/ListMultipartUploads, POST-form uploads, virtual-hosted-style
addressing, SSE headers (ignored), and Content-Disposition/Encoding/Language stored on the object.
For downloads, use `response-content-disposition` on presigned GETs instead.

**Browser uploads.** Set `DRIVEBUCKET_CORS_ORIGINS`, issue a presigned PUT from your backend,
then `fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })`.

**Migrating from S3.** Point `endpoint` at drivebucket and set `forcePathStyle: true`.
To copy data across, any S3 tool that supports custom endpoints works; for example
`aws s3 sync s3://old-bucket s3://photos --endpoint-url https://files.example.com` (two
profiles), or `rclone sync`.

## Endpoints

| Route | |
|---|---|
| `GET/HEAD /:bucket/*key` | Stream object (anonymous for public buckets, otherwise signed). `Range`, `If-None-Match`/`If-Modified-Since` → 304, `If-Match`/`If-Unmodified-Since` → 412, `If-Range`. |
| other S3 routes | See the S3 API section. |
| `…?w=&h=&fit=&format=&q=` | Resize via sharp. `format=webp\|avif\|jpeg\|png\|auto` (`auto` negotiates on `Accept`, sends `Vary: Accept`). `fit=inside` (default) never enlarges. |
| `GET /-/healthy` | Liveness. |
| `GET /-/ready` | Readiness (Drive config resolves). |
| `GET /-/metrics` | Prometheus. |

Errors use S3's XML shape (`<Error><Code>NoSuchKey</Code>…`). Drive's own error messages are
never forwarded to clients.

**Access.** Buckets listed in `DRIVEBUCKET_PUBLIC_BUCKETS` are served without auth. Every other
bucket returns `403 AccessDenied` and doesn't reveal whether it exists. Library users can pass
`authorize(ctx)` instead.

**Safety headers.** Every response carries `X-Content-Type-Options: nosniff` and a sandboxing
CSP. Anything that isn't image/video/audio/font/pdf/plain text (HTML and SVG included) is sent
as `Content-Disposition: attachment`, so user uploads can't run script on your domain.

## Configuration (env)

| Variable | Default | |
|---|---|---|
| `DRIVEBUCKET_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | | OAuth user (free Gmail works) |
| `DRIVEBUCKET_SA_KEY_FILE` or `DRIVEBUCKET_SA_KEY_JSON` | | Service account |
| `DRIVEBUCKET_SA_SUBJECT` | | Domain-wide delegation user |
| `DRIVEBUCKET_SHARED_DRIVE_ID` | | Required for a service account without subject |
| `DRIVEBUCKET_ROOT_FOLDER_ID` | app-created `drivebucket` folder | |
| `DRIVEBUCKET_SCOPE` | `drive.file` | or `drive` |
| `DRIVEBUCKET_PUBLIC_BUCKETS` | | comma list |
| `DRIVEBUCKET_CACHE_CONTROL` | `public, max-age=3600` | for objects without their own |
| `DRIVEBUCKET_RESIZE` | `on` | |
| `DRIVEBUCKET_RESIZE_WIDTHS` | any ≤ 4096 | **set this in production**, otherwise every distinct `w` is a new Drive download + sharp job |
| `DRIVEBUCKET_RESIZE_CACHE_DIR` | `/var/cache/drivebucket` in Docker | disk LRU |
| `DRIVEBUCKET_RESIZE_CACHE_MAX_MB` | 1024 | |
| `DRIVEBUCKET_S3_ACCESS_KEY_ID` / `DRIVEBUCKET_S3_SECRET_ACCESS_KEY` | | enables the S3 API (secret ≥ 16 chars) |
| `DRIVEBUCKET_S3_CREDENTIALS` | | JSON array: `[{"accessKeyId","secretAccessKey","buckets":["photos"],"readOnly":true}]` |
| `DRIVEBUCKET_S3_REGION` | `auto` | pin the signing region |
| `DRIVEBUCKET_MULTIPART_DIR` | OS temp | part spool directory |
| `DRIVEBUCKET_MAX_OBJECT_MB` | | reject larger uploads |
| `DRIVEBUCKET_CORS_ORIGINS` | | comma list or `*` |
| `DRIVEBUCKET_REDIS_URL` | | shared key index; resize cache when no cache dir |
| `DRIVEBUCKET_CONCURRENCY` | 8 | parallel Drive calls |
| `DRIVEBUCKET_TRUST_PROXY` | false | set `true` behind a CDN/LB |
| `PORT`, `HOST`, `DRIVEBUCKET_LOG_LEVEL` | 8080, 0.0.0.0, info | |

Logs never include query strings (presigned URLs carry credentials there), `Authorization` or cookies.

## Behind Cloudflare (or any CDN)

Each uncached download costs **200 Drive quota units** (325k units/min per user). With no CDN,
that's roughly 27 downloads a second before Drive starts rate-limiting you.

- Cache everything for the public hostname and respect origin `Cache-Control`.
  Set long lifetimes on immutable keys: `put(key, body, { cacheControl: 'public, max-age=31536000, immutable' })`.
- Include the query string in the cache key so resize variants are cached separately.
- If you use `format=auto`, make sure the CDN varies on `Accept`. Otherwise use explicit `format=webp`.
- Conditional requests are cheap: a 304 costs one metadata read (5 units) and no download.

## Metrics

`drivebucket_http_requests_total{method,route,status}`, `drivebucket_http_request_duration_seconds`,
`drivebucket_drive_api_calls_total{op,outcome}`, `drivebucket_drive_api_call_duration_seconds`,
`drivebucket_drive_api_retries_total{op,reason}`, `drivebucket_resize_cache_requests_total{result}`,
`drivebucket_resize_duration_seconds`, plus Node process metrics.

Resize cache hit ratio:
`sum(rate(drivebucket_resize_cache_requests_total{result="hit"}[5m])) / sum(rate(drivebucket_resize_cache_requests_total[5m]))`

## As a library

```ts
import { DriveAdapter } from '@drivebucket/core';
import { createServer, DiskResizeCache } from '@drivebucket/server';

const app = await createServer({
  adapter: new DriveAdapter({ auth: { type: 'oauthRefreshToken', clientId, clientSecret, refreshToken } }),
  buckets: { photos: { public: true, cacheControl: 'public, max-age=86400' } },
  resize: { allowedWidths: [320, 640, 1280], cache: new DiskResizeCache({ dir: '/tmp/img' }) },
});
await app.listen({ port: 8080 });
```
