import { DriveAdapter, MemoryLRUIndex, RedisKeyIndex, type KeyIndex } from '@drivebucket/core';
import { createServer } from './app.js';
import { loadConfigFromEnv } from './config.js';
import { DiskResizeCache, MemoryResizeCache, RedisResizeCache, type ResizeCache } from './resize/cache.js';

async function main(): Promise<void> {
  const cfg = loadConfigFromEnv();

  let redis: import('ioredis').Redis | undefined;
  if (cfg.redisUrl) {
    const { Redis } = await import('ioredis');
    redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  }
  const index: KeyIndex = redis ? new RedisKeyIndex(redis) : new MemoryLRUIndex();
  const adapter = new DriveAdapter({ ...cfg.adapter, index });

  let cache: ResizeCache | undefined;
  if (cfg.resize) {
    if (cfg.resize.cacheDir) cache = new DiskResizeCache({ dir: cfg.resize.cacheDir, maxBytes: cfg.resize.cacheMaxBytes });
    else if (redis) cache = new RedisResizeCache(redis);
    else cache = new MemoryResizeCache(Math.min(cfg.resize.cacheMaxBytes, 256 * 1024 * 1024));
  }

  const app = await createServer({
    adapter,
    buckets: cfg.buckets,
    ...(cfg.defaultCacheControl ? { defaultCacheControl: cfg.defaultCacheControl } : {}),
    resize: cfg.resize ? { ...(cfg.resize.allowedWidths ? { allowedWidths: cfg.resize.allowedWidths } : {}), ...(cache ? { cache } : {}) } : false,
    trustProxy: cfg.trustProxy,
    ...(cfg.s3
      ? {
          s3: {
            credentials: cfg.s3.credentials,
            region: cfg.s3.region,
            ...(cfg.s3.multipartDir ? { multipart: { tmpDir: cfg.s3.multipartDir } } : {}),
          },
        }
      : {}),
    ...(cfg.cors ? { cors: cfg.cors } : {}),
    ...(cfg.maxObjectBytes !== undefined ? { maxObjectBytes: cfg.maxObjectBytes } : {}),
  });
  if (!cfg.s3) app.log.info('S3 API disabled (no DRIVEBUCKET_S3_* credentials); serving public read proxy only');

  // Fail fast on bad credentials / shared drive / root folder.
  await adapter.init();
  await app.listen({ port: cfg.port, host: cfg.host });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Message only: errors from config never include secret values, and stack/cause may.
  const e = err as { name?: string; message?: string };
  const hint =
    e.name === 'AuthError'
      ? ' (check the OAuth client id/secret and refresh token, or the service account key, and that the Drive API is enabled)'
      : '';
  console.error(`drivebucket-server: ${e.name ?? 'Error'}: ${e.message ?? String(err)}${hint}`);
  process.exit(1);
});
