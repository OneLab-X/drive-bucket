import { DriveBucketError, type DriveAdapter, evaluateConditionals, isDriveBucketError, parseRange, validateKey } from '@drivebucket/core';
import express, { type ErrorRequestHandler, type Express } from 'express';
import multer from 'multer';
import { DriveStorage, type DriveFileInfo } from './drive-storage.js';

export interface AppOptions {
  adapter: DriveAdapter;
  bucket: string;
  maxBytes?: number;
}

const ALLOWED = /^(image\/(jpeg|png|webp|gif|avif)|application\/pdf)$/;

export function createApp({ adapter, bucket, maxBytes = 10 * 1024 * 1024 }: AppOptions): Express {
  const app = express();
  const upload = multer({
    storage: new DriveStorage({ adapter, bucket, cacheControl: 'public, max-age=31536000, immutable' }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>drivebucket + express</title>
<form method="post" action="/upload" enctype="multipart/form-data">
  <input type="file" name="file" accept="image/*,application/pdf" required> <button>Upload</button>
</form>`);
  });

  app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file as (Express.Multer.File & DriveFileInfo) | undefined;
    if (!file) {
      res.status(400).json({ error: 'No file, or file type not allowed' });
      return;
    }
    res.status(201).json({ key: file.key, url: `/files/${file.key}`, size: file.size, etag: file.etag });
  });

  // Serve with ETag/304 and Range. For public traffic put drivebucket-server + a CDN in front instead.
  app.get('/files/*key', async (req, res, next) => {
    try {
      const key = ([] as string[]).concat(req.params.key as string | string[]).join('/');
      validateKey(key);
      const info = await adapter.head(bucket, key);
      const v = { etag: `"${info.etag}"`, lastModified: info.lastModified };
      res.set({
        'Content-Type': info.contentType,
        ETag: v.etag,
        'Last-Modified': info.lastModified.toUTCString(),
        'Cache-Control': info.cacheControl ?? 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
      });
      const cond = evaluateConditionals(req.headers, v);
      if (cond === 'not-modified') return void res.status(304).end();
      if (cond === 'precondition-failed') return void res.status(412).end();
      const range = parseRange(req.headers.range);
      const out = await adapter.read(bucket, info, range ? { range } : {});
      res.set('Content-Length', String(out.contentLength));
      if (out.range) res.status(206).set('Content-Range', `bytes ${out.range.start}-${out.range.end}/${out.range.total}`);
      out.stream.on('error', next).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code });
      return;
    }
    if (isDriveBucketError(err) && err.status < 500) {
      res.status(err.status).json({ error: (err as DriveBucketError).code });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'InternalError' });
  };
  app.use(onError);
  return app;
}
