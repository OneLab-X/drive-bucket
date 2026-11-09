---
"@drivebucket/next": minor
"@drivebucket/cli": minor
"@drivebucket/core": minor
"@drivebucket/server": patch
---

Add `@drivebucket/next` (App Router `createDriveRoute` with streaming multipart uploads, content sniffing, size/type limits and Range/304 serving; `uploadFile`/`resizeImage` browser helpers) and `@drivebucket/cli` (`auth login` loopback+PKCE, `buckets`, `ls`, `cp`, `rm`, `doctor`). core: `driveOptionsFromEnv()` and shared HTTP helpers (`parseRange`, `evaluateConditionals`); `FakeDrive.getAbout()`. server: uses the shared helpers.
