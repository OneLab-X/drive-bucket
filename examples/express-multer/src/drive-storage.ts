import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { DriveAdapter } from '@drivebucket/core';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';

export interface DriveStorageOptions {
  adapter: DriveAdapter;
  bucket: string;
  /** Object key for an upload. Default: uploads/<uuid><ext>. */
  key?: (req: Request, file: Express.Multer.File) => string;
  cacheControl?: string;
}

/** What multer puts on `req.file` after a successful upload. */
export interface DriveFileInfo {
  bucket: string;
  key: string;
  etag: string;
  size: number;
}

/**
 * multer storage engine that streams each file straight into Google Drive — no temp files,
 * no buffering in memory. Pair it with multer `limits` for size caps.
 */
export class DriveStorage implements StorageEngine {
  constructor(private readonly opts: DriveStorageOptions) {}

  _handleFile(req: Request, file: Express.Multer.File, cb: (error?: unknown, info?: Partial<Express.Multer.File> & DriveFileInfo) => void): void {
    const key = this.opts.key?.(req, file) ?? `uploads/${randomUUID()}${extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
    this.opts.adapter
      .put(this.opts.bucket, key, file.stream, {
        contentType: file.mimetype || 'application/octet-stream',
        ...(this.opts.cacheControl ? { cacheControl: this.opts.cacheControl } : {}),
        metadata: { originalname: encodeURIComponent(file.originalname).slice(0, 100) },
      })
      .then((res) => cb(null, { bucket: this.opts.bucket, key: res.key, etag: res.etag, size: res.size }))
      .catch(cb);
  }

  /** Called by multer when a later step fails (e.g. a size limit tripped): undo the upload. */
  _removeFile(_req: Request, file: Express.Multer.File & Partial<DriveFileInfo>, cb: (error: Error | null) => void): void {
    if (!file.key) return cb(null);
    this.opts.adapter
      .delete(this.opts.bucket, file.key, { permanent: true })
      .then(() => cb(null))
      .catch((err: Error) => cb(err));
  }
}
