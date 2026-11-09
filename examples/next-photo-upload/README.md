# next-photo-upload

Photos are resized in the browser, streamed to Google Drive through a Next.js route, and shown
in a gallery. The gallery can use resized variants from `drivebucket-server` behind a CDN.

```bash
cp .env.example .env.local
npx @drivebucket/cli auth login --client-id … --client-secret … >> .env.local
pnpm dev
```

- `app/api/files/[[...key]]/route.ts`: `createDriveRoute` (streaming upload + serve).
- `app/page.tsx`: `uploadFile(file, { resize: { maxEdge: 2048 } })` with progress.
- Set `NEXT_PUBLIC_DRIVEBUCKET_PROXY_URL` to a `drivebucket-server` with
  `DRIVEBUCKET_PUBLIC_BUCKETS=photos` to serve `?w=320/640&format=webp` variants through your CDN.
- Uploads are open in `next dev`. In production, `lib/drive.ts` requires `UPLOAD_TOKEN`; replace
  `canUpload()` with your real auth.
