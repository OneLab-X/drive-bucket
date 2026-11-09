# @drivebucket/server

## 0.1.0

### Minor Changes

- 5c01393: server: read proxy (GET/HEAD with Range, conditional requests, S3 XML errors), sharp image resizing with memory/disk/Redis variant caches, Prometheus metrics, health endpoints, env config and Docker image. core: `DriveAdapter.read()` to stream an already-resolved object, `observe()` for call/retry events, and `@drivebucket/core/testing` exporting `FakeDrive`.
- 5c01393: server: S3-compatible API — SigV4 header and presigned auth (incl. signed/unsigned aws-chunked bodies with trailer checksums), Put/Get/Head/Delete/DeleteObjects/Copy, ListObjects v1/v2, bucket CRUD, multipart uploads mapped onto Drive resumable sessions, `presignUrl()`, CORS, scoped and read-only access keys. core: `createUpload()` streaming uploads, `expectedMd5` (Content-MD5) checked before commit, `BadDigest` error, and early body-stream errors no longer surface as unhandled events.

### Patch Changes

- 5c01393: Add `@drivebucket/next` (App Router `createDriveRoute` with streaming multipart uploads, content sniffing, size/type limits and Range/304 serving; `uploadFile`/`resizeImage` browser helpers) and `@drivebucket/cli` (`auth login` loopback+PKCE, `buckets`, `ls`, `cp`, `rm`, `doctor`). core: `driveOptionsFromEnv()` and shared HTTP helpers (`parseRange`, `evaluateConditionals`); `FakeDrive.getAbout()`. server: uses the shared helpers.
- Updated dependencies [5c01393]
- Updated dependencies [5c01393]
- Updated dependencies [5c01393]
- Updated dependencies [5c01393]
  - @drivebucket/core@0.1.0
