import { Readable } from 'node:stream';
import { DriveAdapter, type DriveAdapterOptions } from '../src/drive-adapter.js';
import { FakeDrive } from './fake-drive.js';

export const noSleep = { sleep: async () => {}, random: () => 0 };

export function setup(opts: Partial<DriveAdapterOptions> = {}) {
  const fake = new FakeDrive();
  const adapter = new DriveAdapter({ api: fake, retry: noSleep, ...opts });
  return { fake, adapter };
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

/** Readable that emits `total` deterministic bytes in uneven pieces. */
export function patternStream(total: number, piece = 100_003): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) return this.push(null);
      const n = Math.min(piece, total - sent);
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = (sent + i) % 251;
      sent += n;
      this.push(b);
    },
  });
}

export function patternBuffer(total: number): Buffer {
  const b = Buffer.alloc(total);
  for (let i = 0; i < total; i++) b[i] = i % 251;
  return b;
}
