# Docker + Cloudflare

`drivebucket-server` gives you an S3-compatible endpoint and a public image proxy. Put a CDN in
front: every uncached read is a Drive download costing 200 quota units.

## 1. Run the server

`.env`:

```bash
DRIVEBUCKET_CLIENT_ID=…
DRIVEBUCKET_CLIENT_SECRET=…
DRIVEBUCKET_REFRESH_TOKEN=…
DRIVEBUCKET_PUBLIC_BUCKETS=photos                 # served without auth through the proxy
DRIVEBUCKET_RESIZE_WIDTHS=320,640,1280,1920       # stop arbitrary ?w= cache busting
DRIVEBUCKET_CACHE_CONTROL=public, max-age=86400
DRIVEBUCKET_S3_ACCESS_KEY_ID=app                  # enables the S3 API
DRIVEBUCKET_S3_SECRET_ACCESS_KEY=$(openssl rand -base64 30)
DRIVEBUCKET_CORS_ORIGINS=https://app.example.com  # browser uploads to presigned URLs
DRIVEBUCKET_TRUST_PROXY=true
```

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d                  # server + Redis (shared key index)
curl localhost:8080/-/ready
```

Service account on Workspace instead: mount the key and set
`DRIVEBUCKET_SA_KEY_FILE=/run/secrets/sa.json` plus `DRIVEBUCKET_SHARED_DRIVE_ID`. Add the
service account to the shared drive as a Content manager first.

**Single replica.** S3 multipart upload state is held in memory. Scale reads with the CDN, not
with more replicas. If you do run several, route each multipart upload to one instance.

## 2. Expose it through Cloudflare

Prefer a **Cloudflare Tunnel** (`cloudflared`), so the origin has no public port:

```yaml
# docker-compose.yml (add)
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment: [TUNNEL_TOKEN=…]
```

Point the tunnel's public hostname (e.g. `files.example.com`) at `http://drivebucket:8080`.

## 3. Cache rules

In Cloudflare → Caching → Cache Rules, for `files.example.com` and requests **without**
`Authorization` and **without** `X-Amz-Signature` in the query:

- **Eligible for cache**, edge TTL: *use cache-control header from origin*.
- **Cache key**: include the full query string, so `?w=640` and `?w=320` are separate entries.
- If you use `format=auto`, vary on `Accept` (or use explicit `format=webp`).
- Enable **Tiered Cache** to cut origin hits further.

Bypass the cache for everything signed (`Authorization` header or `X-Amz-*` query). Those are S3
API calls and presigned URLs.

Upload with immutable keys and long lifetimes:

```ts
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: `u/${id}.webp`, Body, ContentType: 'image/webp',
  CacheControl: 'public, max-age=31536000, immutable' }));
```

Then render `https://files.example.com/photos/u/<id>.webp?w=640`.

Check your CDN plan's terms for serving large files and video. Cloudflare's self-serve CDN terms
restrict video-heavy and large-file use outside its media products.

## 4. Watch it

`/-/metrics` (Prometheus):

- `drivebucket_drive_api_calls_total{op,outcome}`: tracks quota burn. Count `files.get(media)` × 200.
- `drivebucket_drive_api_retries_total{reason="userRateLimitExceeded"}`: you're at the per-user limit.
- `drivebucket_resize_cache_requests_total`: hit ratio of the resize cache.
- `drivebucket_http_requests_total{status="503"}`: `SlowDown` returned to clients.

Run `drivebucket doctor` (CLI) after any credential change.
