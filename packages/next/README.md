# @drivebucket/next

Upload and serve files from Google Drive in a Next.js App Router app. Uploads are streamed as
`multipart/form-data` (no base64 JSON, no buffering the whole file), and images can be
downscaled in the browser before they're sent.

## Route

`app/api/files/[[...key]]/route.ts`:

```ts
import { DriveAdapter, driveOptionsFromEnv } from '@drivebucket/core';
import { createDriveRoute } from '@drivebucket/next';
import { auth } from '@/auth'; // your session check

export const runtime = 'nodejs'; // needs Node streams; not the Edge runtime

export const { GET, HEAD, POST } = createDriveRoute({
  adapter: () => new DriveAdapter(driveOptionsFromEnv()), // lazy: not created at build time
  bucket: 'photos',
  auth: async () => Boolean(await auth()),
  maxBytes: 15 * 1024 * 1024,
  allowedTypes: ['image/*'],
});
```

- `POST /api/files` (multipart, field `file`) → `201 { files: [{ key, url, size, etag, contentType, name }] }`.
  Keys are generated as `uploads/YYYY/MM/<uuid>.<ext>`. Override with `keyPrefix` or `generateKey`.
- `GET|HEAD /api/files/<key>` streams the file with `ETag`/304, `Range`/206,
  `Cache-Control` (default `public, max-age=31536000, immutable`), `nosniff` and a sandboxing CSP.
- `maxBytes` is enforced while streaming. A request with more than `maxFiles` files, or any file that
  fails, stores nothing.
- **Content type comes from the file's bytes when they're recognizable** (JPEG, PNG, GIF, WebP, AVIF, HEIC,
  PDF, MP4, WebM, MP3, Ogg, ZIP, HTML, SVG). An HTML file labelled `image/png` is rejected by
  `allowedTypes: ['image/*']`. HTML and SVG are always served as attachments.
- `protectReads: true` applies `auth` to GET/HEAD too.
- `publicUrl: (key) => \`https://cdn.example.com/photos/${key}\`` returns a URL served through
  `drivebucket-server` behind a CDN instead of through this route (recommended for public images).

## Client

```tsx
'use client';
import { uploadFile } from '@drivebucket/next/client';

const { url } = await uploadFile(file, {
  resize: { maxEdge: 2048, quality: 0.82 }, // WebP by default; JPEG fallback
  onProgress: (loaded, total) => setPct(loaded / total),
});
```

`resizeImage()` honours EXIF orientation and never enlarges. It leaves GIF/SVG/non-images alone,
and keeps the original if the browser can't decode it (e.g. HEIC in Chrome) or if re-encoding wouldn't
make it smaller. Errors throw `UploadError` with `status` and `code` (`EntityTooLarge`,
`UnsupportedMediaType`, `Unauthorized`, …).
