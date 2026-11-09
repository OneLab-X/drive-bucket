# Migrating from S3 (or R2, GCS-interop, MinIO)

## 1. Check the fit

Go through [the limits](../README.md#limits-read-this-first). Things that commonly block a move:
- more than ~500k objects in one bucket
- more than ~750 GB uploaded per day
- versioning, object lock, lifecycle rules, ACLs or bucket policies
- a hot public origin with no CDN in front
- code that lists large prefixes on hot paths

## 2. Deploy drivebucket-server

Follow [Docker + Cloudflare](docker-cloudflare.md). Create the buckets:

```bash
drivebucket --env-file .env buckets create photos
```

## 3. Copy the data with rclone

```ini
# ~/.config/rclone/rclone.conf
[old]
type = s3
provider = AWS
env_auth = true
region = us-east-1

[drivebucket]
type = s3
provider = Other
endpoint = https://files.example.com
access_key_id = app
secret_access_key = …
force_path_style = true
```

```bash
rclone sync old:my-bucket drivebucket:photos \
  --transfers 4 --checkers 8 --tpslimit 8 \
  --s3-upload-cutoff 64M --s3-chunk-size 16M \
  --progress
```

- `--tpslimit`/`--transfers` keep you under Drive's per-user rate limit. If the server's
  `drivebucket_drive_api_retries_total` climbs, lower them.
- Budget **750 GB/day**. For bigger buckets, run `rclone sync` once a day until it's done.
- Re-running is safe: rclone compares sizes and MD5 ETags.
- `aws s3 sync` and `mc mirror` work as well with `--endpoint-url` / path-style.

## 4. Point your app at it

```ts
const s3 = new S3Client({
  endpoint: 'https://files.example.com',
  forcePathStyle: true,     // required
  region: 'us-east-1',      // any value; signature region is not enforced unless DRIVEBUCKET_S3_REGION is set
  credentials: { accessKeyId: 'app', secretAccessKey: process.env.DRIVEBUCKET_S3_SECRET! },
});
```

Presigned URLs from `@aws-sdk/s3-request-presigner` keep working. They point at your endpoint.

## 5. What behaves differently

| | S3 | drivebucket |
|---|---|---|
| Multipart ETag | `md5-of-part-md5s-N` | MD5 of the whole object (matches later GET/HEAD) |
| Multipart Complete | any subset of parts | exactly parts 1..N; a part already written can't be replaced |
| Listing | indexed, cheap | scans the bucket on every call |
| Conditional writes | atomic | best effort |
| `Content-Disposition`/`Content-Encoding` on objects | stored | not stored; use `response-content-disposition` on presigned GETs |
| Virtual-hosted buckets | yes | no (`forcePathStyle: true`) |
| Delete | immediate | Drive trash by default (`DRIVEBUCKET_PERMANENT_DELETE=true`) |
| Versioning, ACLs, tagging, lifecycle, SSE | yes | `501 NotImplemented` (SSE headers ignored) |

## 6. Keep a way back

Keep the old bucket read-only until you've watched a full traffic cycle. `rclone sync
drivebucket:photos old:my-bucket` copies everything back.
