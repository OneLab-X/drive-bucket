---
"@drivebucket/server": minor
"@drivebucket/core": minor
---

server: S3-compatible API — SigV4 header and presigned auth (incl. signed/unsigned aws-chunked bodies with trailer checksums), Put/Get/Head/Delete/DeleteObjects/Copy, ListObjects v1/v2, bucket CRUD, multipart uploads mapped onto Drive resumable sessions, `presignUrl()`, CORS, scoped and read-only access keys. core: `createUpload()` streaming uploads, `expectedMd5` (Content-MD5) checked before commit, `BadDigest` error, and early body-stream errors no longer surface as unhandled events.
