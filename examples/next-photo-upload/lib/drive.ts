import { DriveAdapter, driveOptionsFromEnv } from '@drivebucket/core';

export const BUCKET = process.env.BUCKET ?? 'photos';

// One adapter per server process (survives dev hot reloads), created on first use, not at build time.
const g = globalThis as unknown as { __drivebucket?: Promise<DriveAdapter> };

export function getAdapter(): Promise<DriveAdapter> {
  g.__drivebucket ??= (async () => {
    const adapter = new DriveAdapter(driveOptionsFromEnv());
    await adapter.createBucket(BUCKET).catch((err: { code?: string }) => {
      if (err.code !== 'BucketAlreadyOwnedByYou') throw err;
    });
    return adapter;
  })().catch((err) => {
    g.__drivebucket = undefined;
    throw err;
  });
  return g.__drivebucket;
}

/** Replace with your real session check (NextAuth, Clerk, …). */
export function canUpload(req: Request): boolean {
  const token = process.env.UPLOAD_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production';
  return req.headers.get('x-upload-token') === token;
}
