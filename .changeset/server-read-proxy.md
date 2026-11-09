---
"@drivebucket/server": minor
"@drivebucket/core": minor
---

server: read proxy (GET/HEAD with Range, conditional requests, S3 XML errors), sharp image resizing with memory/disk/Redis variant caches, Prometheus metrics, health endpoints, env config and Docker image. core: `DriveAdapter.read()` to stream an already-resolved object, `observe()` for call/retry events, and `@drivebucket/core/testing` exporting `FakeDrive`.
