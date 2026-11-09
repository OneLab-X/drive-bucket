import { DriveAdapter, driveOptionsFromEnv } from '@drivebucket/core';
import { createApp } from './app.js';

// Credentials from .env — create them with: npx @drivebucket/cli auth login > .env
const adapter = new DriveAdapter(driveOptionsFromEnv());
const bucket = process.env.BUCKET ?? 'uploads';

await adapter.init();
await adapter.createBucket(bucket).catch((err: { code?: string }) => {
  if (err.code !== 'BucketAlreadyOwnedByYou') throw err;
});

const port = Number(process.env.PORT ?? 3000);
createApp({ adapter, bucket }).listen(port, () => console.log(`http://localhost:${port}`));
