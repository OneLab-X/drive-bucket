# Contributing

```bash
corepack enable
pnpm install
pnpm check        # typecheck + build + unit tests + publint + attw
```

- **Tests first.** Unit tests use `FakeDrive` (`packages/core/src/testing`). If you depend on a
  new Drive behaviour, teach the fake to enforce it. S3 behaviour is tested with the real
  `@aws-sdk/client-s3` in `packages/server/test/s3-compat.test.ts`.
- **Real Drive.** `DRIVEBUCKET_IT=1 pnpm test:it` with an OAuth refresh token for a throwaway
  account (see `.env.example`). CI runs this weekly and on demand.
- **Changesets.** Every user-visible change needs `pnpm changeset`.
- **Security-sensitive code** (SigV4, chunked decoding, key validation, error mapping) needs a
  test for the failure path, not just the happy path.
- Never log credentials, query strings of presigned URLs, or Drive error bodies to clients.
