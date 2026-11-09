# Quickstart: Next.js (App Router)

Runnable version: [`examples/next-photo-upload`](../examples/next-photo-upload).

```bash
npm i @drivebucket/core @drivebucket/next
npx @drivebucket/cli auth login --client-id … --client-secret … >> .env.local
```

## 1. Route

`app/api/files/[[...key]]/route.ts`:

```ts
import { DriveAdapter, driveOptionsFromEnv } from '@drivebucket/core';
import { createDriveRoute } from '@drivebucket/next';
import { auth } from '@/auth';

export const runtime = 'nodejs';

export const { GET, HEAD, POST } = createDriveRoute({
  adapter: () => new DriveAdapter(driveOptionsFromEnv()),
  bucket: 'photos',
  auth: async () => Boolean(await auth()),
  maxBytes: 12 * 1024 * 1024,
  allowedTypes: ['image/*'],
});
```

`next.config.ts`: keep the Google client out of the bundle.

```ts
export default { serverExternalPackages: ['@googleapis/drive', 'googleapis-common', 'google-auth-library', 'busboy'] };
```

## 2. Upload from a client component

```tsx
'use client';
import { uploadFile } from '@drivebucket/next/client';

<input type="file" accept="image/*" onChange={async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const { key, url } = await uploadFile(file, { resize: { maxEdge: 2048, quality: 0.82 } });
  // persist `key` with your record; render `url`
}} />
```

The browser downscales to WebP (falling back to JPEG) before upload. That's faster, and it uses
less of Drive's 750 GB/day budget.

## 3. Render

`url` points at your route (`/api/files/<key>`), which sends `immutable` caching headers. For
galleries, run [`drivebucket-server`](docker-cloudflare.md) behind a CDN and render resized variants:

```tsx
<img src={`${PROXY}/photos/${key}?w=640&format=webp`} srcSet={`${PROXY}/photos/${key}?w=320&format=webp 320w, ${PROXY}/photos/${key}?w=640&format=webp 640w`} />
```

Pass `publicUrl: (key) => \`${PROXY}/photos/${key}\`` to `createDriveRoute` so uploads return that URL directly.

## Notes

- Route handlers need the **Node.js runtime**, not Edge.
- Store the returned `key` in your database. Listing a Drive bucket scans the whole folder.
- `protectReads: true` puts reads behind `auth` as well.
