/**
 * Browser helpers. No Node imports: safe to use in client components.
 *
 *   import { uploadFile } from '@drivebucket/next/client';
 *   const { url } = await uploadFile(file, { resize: { maxEdge: 2048, quality: 0.82 } });
 */

export interface ResizeOptions {
  /** Longest edge in px after resize. Smaller images are not enlarged. */
  maxEdge: number;
  /** 0..1, default 0.82. */
  quality?: number;
  /** Output type. Default image/webp (falls back to image/jpeg where WebP encoding is unsupported). */
  type?: 'image/webp' | 'image/jpeg' | 'image/png';
}

export interface UploadOptions {
  /** Route URL. Default `/api/files`. */
  endpoint?: string;
  resize?: ResizeOptions;
  /** Form field name. Default `file`. */
  fieldName?: string;
  headers?: Record<string, string>;
  /** Upload progress (uses XMLHttpRequest when set). */
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** fetch credentials mode. Default `same-origin`. */
  credentials?: RequestCredentials;
}

export interface UploadedFile {
  key: string;
  url: string;
  size: number;
  etag: string;
  contentType: string;
  name: string;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Target size for a resize; never enlarges. */
export function computeResize(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (!(maxEdge > 0) || longest <= maxEdge) return { width, height, scale: 1 };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** What the resizer needs from the browser. Injectable for tests and non-DOM runtimes. */
export interface CanvasEnv {
  createImageBitmap(blob: Blob, opts?: ImageBitmapOptions): Promise<{ width: number; height: number; close?(): void }>;
  /** Draw `bitmap` at width×height and encode. */
  encode(bitmap: unknown, width: number, height: number, type: string, quality: number): Promise<Blob | null>;
}

export function browserCanvasEnv(): CanvasEnv {
  return {
    createImageBitmap: (blob, opts) => globalThis.createImageBitmap(blob, opts),
    async encode(bitmap, width, height, type, quality) {
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
        return canvas.convertToBlob({ type, quality });
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    },
  };
}

const NOT_RESIZABLE = new Set(['image/gif', 'image/svg+xml']);
const EXT: Record<string, string> = { 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png' };

function renamed(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return base + (EXT[type] ?? '');
}

/**
 * Downscale an image in the browser before upload. Honors EXIF orientation. Returns the
 * original file for non-images, GIF/SVG, decode failures, or when re-encoding wouldn't help.
 */
export async function resizeImage(file: File | Blob, opts: ResizeOptions, env: CanvasEnv = browserCanvasEnv()): Promise<File | Blob> {
  if (!file.type.startsWith('image/') || NOT_RESIZABLE.has(file.type)) return file;
  let bitmap: Awaited<ReturnType<CanvasEnv['createImageBitmap']>>;
  try {
    bitmap = await env.createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file; // e.g. HEIC in browsers that can't decode it: upload as-is
  }
  try {
    const target = computeResize(bitmap.width, bitmap.height, opts.maxEdge);
    const wanted = opts.type ?? 'image/webp';
    if (target.scale === 1 && file.type === wanted) return file;
    const quality = opts.quality ?? 0.82;
    let out = await env.encode(bitmap, target.width, target.height, wanted, quality);
    // Canvas silently falls back to PNG when it can't encode the requested type.
    if (out && out.type !== wanted && wanted === 'image/webp') out = await env.encode(bitmap, target.width, target.height, 'image/jpeg', quality);
    if (!out) return file;
    if (target.scale === 1 && out.size >= file.size) return file;
    const name = 'name' in file && typeof file.name === 'string' ? file.name : 'image';
    return typeof File !== 'undefined' ? new File([out], renamed(name, out.type), { type: out.type }) : out;
  } finally {
    bitmap.close?.();
  }
}

function parseError(status: number, text: string): UploadError {
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
    return new UploadError(status, j.error?.code ?? 'UploadFailed', j.error?.message ?? `Upload failed (${status})`);
  } catch {
    return new UploadError(status, 'UploadFailed', `Upload failed (${status})`);
  }
}

/** Optionally resize, then POST as multipart/form-data to a `createDriveRoute` endpoint. */
export async function uploadFile(file: File | Blob, opts: UploadOptions = {}, env?: CanvasEnv): Promise<UploadedFile> {
  const body = opts.resize ? await resizeImage(file, opts.resize, env) : file;
  const form = new FormData();
  const name = 'name' in body && typeof body.name === 'string' ? body.name : 'name' in file && typeof file.name === 'string' ? file.name : 'file';
  form.append(opts.fieldName ?? 'file', body, name);
  const endpoint = opts.endpoint ?? '/api/files';

  let status: number;
  let text: string;
  if (opts.onProgress && typeof XMLHttpRequest !== 'undefined') {
    ({ status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.withCredentials = opts.credentials === 'include';
      for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => opts.onProgress!(e.loaded, e.lengthComputable ? e.total : body.size);
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new UploadError(0, 'NetworkError', 'Network error during upload'));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    }));
  } else {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: form,
      credentials: opts.credentials ?? 'same-origin',
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) throw parseError(status, text);
  const json = JSON.parse(text) as { files: UploadedFile[] };
  const first = json.files?.[0];
  if (!first) throw new UploadError(status, 'UploadFailed', 'Server returned no file');
  return first;
}
