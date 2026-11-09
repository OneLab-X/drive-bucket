# @drivebucket/core

```ts
import { DriveAdapter } from '@drivebucket/core';

const drive = new DriveAdapter({
  auth: {
    type: 'oauthRefreshToken',
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  },
  // scope: 'drive.file' (default) — only files this app created.
});
await drive.init();                       // fail fast on bad config
await drive.createBucket('photos').catch(() => {});

const photos = drive.bucket('photos');    // StorageAdapter bound to one bucket
await photos.put('2026/cat.jpg', buffer, { contentType: 'image/jpeg', metadata: { album: 'pets' } });
const { stream, etag, size } = await photos.get('2026/cat.jpg', { range: { start: 0, end: 1023 } });
const page = await photos.list({ prefix: '2026/', delimiter: '/' });
await photos.copy('2026/cat.jpg', 'archive/cat.jpg');
await photos.delete('2026/cat.jpg');      // trash; { permanent: true } to hard-delete
```

### Auth

- `oauthRefreshToken` — any Google account, including free Gmail.
- `serviceAccount` + `sharedDriveId` — Workspace. The service account must be a member of the
  shared drive. Startup fails with a clear `ConfigError` otherwise.
- `serviceAccount` + `subject` — domain-wide delegation, acts as that user.

### Storage layout

Buckets are folders under a root folder (created by the app in My Drive, or the shared-drive
root). Objects are flat files in the bucket folder; the full key, bucket and a SHA-256 lookup
hash live in `appProperties` (keys up to 1024 bytes are chunked to fit Drive's 124-byte limit).
Large metadata spills into the file `description`.

### Key index

`(bucket, key) → fileId` cache. `MemoryLRUIndex` (default), `RedisKeyIndex` (ioredis-compatible),
`MongoKeyIndex`. A miss costs one Drive `files.list`; a stale hit self-heals.

### Errors

`NoSuchKey`, `NoSuchBucket`, `QuotaExceeded`, `RateLimited`, `DailyUploadLimit`, `AuthError`,
`ItemLimitExceeded`, `PreconditionFailed`, `InvalidKey`, `InvalidRange`, `ConfigError` — all
extend `DriveBucketError` with `code` and `status`.
