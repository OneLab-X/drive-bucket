import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive } from '@drivebucket/core/testing';
import sharp from 'sharp';
import { createServer, type ServerOptions } from '../src/app.js';
import { MemoryResizeCache } from '../src/resize/cache.js';

export async function makeImage(width = 400, height = 300, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .toFormat(format)
    .toBuffer();
}

export async function setupServer(opts: Partial<ServerOptions> = {}) {
  const fake = new FakeDrive();
  const adapter = new DriveAdapter({ api: fake, retry: { sleep: async () => {}, random: () => 0 } });
  await adapter.createBucket('pub');
  await adapter.createBucket('priv');
  const cache = new MemoryResizeCache();
  const app = await createServer({
    adapter,
    buckets: { pub: { public: true } },
    logger: false,
    resize: { cache },
    ...opts,
  });
  await app.ready();
  return { app, adapter, fake, cache, pub: adapter.bucket('pub'), priv: adapter.bucket('priv') };
}
