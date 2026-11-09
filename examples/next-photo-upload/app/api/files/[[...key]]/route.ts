import { createDriveRoute } from '@drivebucket/next';
import { BUCKET, canUpload, getAdapter } from '@/lib/drive';

export const runtime = 'nodejs';

export const { GET, HEAD, POST } = createDriveRoute({
  adapter: getAdapter,
  bucket: BUCKET,
  auth: canUpload,
  keyPrefix: 'photos/',
  maxBytes: 12 * 1024 * 1024,
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'],
});
