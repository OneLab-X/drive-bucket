# drivebucket

**Use Google Drive as object storage.** Use Google Drive as the object store for a
low- to medium-volume app (photos, documents, backups) instead of S3, GCS or Azure Blob.
It's free on a personal Google account, or uses the storage your Workspace plan already includes.
It speaks the S3 API, so existing `@aws-sdk/client-s3` code works by changing `endpoint`.

```ts
const s3 = new S3Client({ endpoint: 'https://files.example.com', forcePathStyle: true, region: 'us-east-1', credentials });
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.jpg', Body, ContentType: 'image/jpeg' }));
```

> **Read [the limits](#limits-read-this-first) before you rely on it.** Drive is not S3. It works
> well for an app with thousands of users and a CDN in front. It is the wrong tool for a busy
> public CDN origin or a data lake.

| Package | What it is |
|---|---|
| [`@drivebucket/core`](packages/core) | `DriveAdapter`: buckets, put/get/head/list/copy/delete, resumable uploads, retries, key index (memory/Redis/Mongo) |
| [`@drivebucket/server`](packages/server) | Docker image: S3-compatible API (SigV4, presigned URLs, multipart), public read proxy, image resizing, Prometheus metrics |
| [`@drivebucket/next`](packages/next) | Next.js App Router upload/serve route + browser-side resize & upload |
| [`@drivebucket/cli`](packages/cli) | `drivebucket auth login`, `doctor`, `buckets`, `ls`, `cp`, `rm` |

## Quick start

1. Google Cloud Console: enable the **Google Drive API**, create an **OAuth client (Desktop app)**,
   and **publish** the consent screen. In *Testing* mode refresh tokens expire after 7 days.
2. Get a refresh token and check the setup:

```bash
npx @drivebucket/cli auth login --client-id ID --client-secret SECRET > .env
npx @drivebucket/cli --env-file .env doctor
npx @drivebucket/cli --env-file .env buckets create photos
```

3. Pick an integration:

| Guide | |
|---|---|
| [Express](docs/quickstart-express.md) | `DriveAdapter` + a streaming multer storage engine |
| [Next.js](docs/quickstart-nextjs.md) | `createDriveRoute()` + `uploadFile()` with client-side resize |
| [Docker + Cloudflare](docs/docker-cloudflare.md) | S3 endpoint and public image proxy behind a CDN |
| [Migrating from S3](docs/migrate-from-s3.md) | Copy data with rclone, change `endpoint`, check what differs |

Runnable examples: [`examples/express-multer`](examples/express-multer),
[`examples/next-photo-upload`](examples/next-photo-upload).

## How it works

- **Bucket = folder** under a root folder: one the app creates in My Drive, or a shared drive.
- **Object = file**, kept flat in the bucket folder. Its key, bucket and a SHA-256 lookup hash are
  stored in private `appProperties`. "Directories" exist only in keys, as in S3.
- **Lookups** go through a key → file-id cache (in-process LRU, Redis or MongoDB). A cache miss costs one Drive search.
- **Uploads** use multipart up to 5 MB and resumable sessions above that. The MD5 is checked
  end to end, and overwrites keep the same Drive file id.
- **Reads** stream `files.get?alt=media` with byte ranges. Files are never shared publicly in Drive;
  a "public" bucket only means the proxy serves it without auth.
- **Scope:** `drive.file` by default, so the app can only see files it created. Full `drive` is opt-in.

## Limits (read this first)

| Limit | Value | What it means for you |
|---|---|---|
| Upload volume | **750 GB per user per day**, copies included | After that, uploads and copies fail (`DailyUploadLimit`) for 24 h. |
| API quota (since 1 May 2026) | **325,000 units/min per user**, 1,000,000/min per project, 400 M/day per project | Uncached download = 200 units, list page = 100, write = 50, metadata read = 5. That's about **27 uncached downloads/s per user**. Google has announced charges for going over, "later in 2026". |
| Retries | 429/403 rate limits and 5xx get exponential backoff, up to 6 attempts | Sustained overload surfaces as `RateLimited` / S3 `SlowDown`. |
| Objects per bucket | ~**500,000** (Drive's per-folder item cap) | Shard across buckets beyond that. |
| Shared drive | **500,000 items total, trash included** | Use `permanentDelete` if you churn files. |
| Items per account | 500 million | |
| Object size | 5 TB | |
| Key length | 1024 bytes UTF-8; `.`/`..` segments and control characters rejected | Stored in ≤120-byte chunks to fit Drive's 124-byte property limit. |
| User metadata | 2 KB | Small values go in `appProperties`; larger metadata moves to the file description. |
| Listing | **Scans the whole bucket** (1000 files per call, 100 units each) | Drive can't filter by prefix. Fine for thousands of objects; costly for hundreds of thousands. |
| Consistency | Listing is eventually consistent; **no atomic conditional writes** | `If-Match`/`If-None-Match` are best effort. Concurrent writers on separate processes can race (newest wins, duplicates are cleaned up on read). |
| Service accounts | **No storage quota of their own** | Use a shared drive (Workspace) or domain-wide delegation. drivebucket refuses to start otherwise. |
| S3 API | Subset: path-style only, no versioning/ACLs/tagging/object lock | Multipart Complete must list parts 1..N. Upload state lives in one process. See [server](packages/server/README.md#s3-api). |
| `drive` scope | Restricted | Public apps need Google's verification and possibly a security assessment. `drive.file` needs neither. |

### Terms, abuse and when *not* to use this

- **Not a CDN origin for high traffic without a cache.** Every uncached read is a Drive download
  billed against your quota. Put Cloudflare or another CDN in front, use long `Cache-Control` and
  immutable keys, and expect a cold cache to be slow.
- **You are bound by Google's terms.** That means the [Google Drive Terms](https://support.google.com/drive/answer/2450387),
  the [Google APIs Terms of Service](https://developers.google.com/terms) and the program policies.
  Automated, high-volume public distribution of files from a consumer account can trigger abuse
  review, which can lock files or the account. drivebucket never creates "anyone with the link"
  shares and never hotlinks `drive.google.com`/`lh3`/`uc?export` URLs; Google has made those
  unreliable since early 2024. It can't make an unsuitable workload acceptable.
- **Prefer a Workspace account for anything business-critical.** You get pooled storage, shared
  drives, service accounts and an admin who can recover access. Back up anything you can't lose.
- **Use real object storage** for: sustained throughput above a few requests per second per user,
  millions of objects per bucket, strong consistency, compliance requirements (residency,
  retention, object lock), or serving video at scale.

## Security

- Credentials never appear in logs. Query strings, `Authorization` and cookies are redacted,
  and config errors never echo secrets.
- Keys are validated: no `..` or `.` segments, no control characters, at most 1024 bytes.
- There are content-type allowlists, with types sniffed from the file's bytes in the Next.js route, and size limits that are
  enforced while the body streams in.
- SigV4 allows 15 minutes of clock skew, and presigned URLs expire after at most 7 days. Upload payloads are verified (signed
  SHA-256, chunk signatures, CRC32/SHA trailers) before anything is committed.
- Served user content gets `nosniff`, a sandboxing CSP, and `attachment` for HTML/SVG.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Develop

```bash
pnpm install
pnpm check                      # typecheck, build, unit tests, publint, are-the-types-wrong
DRIVEBUCKET_IT=1 pnpm test:it   # against real Drive (see .env.example)
pnpm changeset                  # describe your change for the changelog
```

Unit tests run against `FakeDrive` (`@drivebucket/core/testing`), an in-memory Drive that
enforces Drive's property and upload-chunk rules. The S3 suite drives the server with the real
`@aws-sdk/client-s3`. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. Not affiliated with Google.
