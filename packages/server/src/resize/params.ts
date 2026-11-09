import { createHash } from 'node:crypto';
import { HttpError } from '../http/s3-error.js';

export type OutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';
export type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface ResizeParams {
  width?: number;
  height?: number;
  fit: Fit;
  format: OutputFormat;
  quality: number;
  /** True when format came from Accept negotiation (`format=auto`): response must `Vary: Accept`. */
  negotiated: boolean;
}

export interface ResizeLimits {
  maxWidth: number;
  maxHeight: number;
  /** If set, `w` must be one of these. Stops cache-busting with arbitrary sizes. */
  allowedWidths?: number[];
  allowedHeights?: number[];
  defaultQuality: number;
}

const RESIZE_KEYS = ['w', 'h', 'format', 'q', 'fit'] as const;
const FITS = new Set<Fit>(['cover', 'contain', 'fill', 'inside', 'outside']);
const FORMATS = new Set<OutputFormat>(['webp', 'avif', 'jpeg', 'png']);

/** Source types sharp may decode. SVG deliberately excluded (rendering untrusted SVG is risky). */
export const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff', 'image/heif', 'image/heic']);

export function wantsResize(query: Record<string, unknown>): boolean {
  return RESIZE_KEYS.some((k) => query[k] !== undefined);
}

function intParam(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new HttpError(400, 'InvalidArgument', `${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw new HttpError(400, 'InvalidArgument', `${name} must be between ${min} and ${max}`);
  return n;
}

function negotiate(accept: string | undefined, sourceType: string): OutputFormat {
  const a = accept ?? '';
  if (/image\/avif/.test(a)) return 'avif';
  if (/image\/webp/.test(a)) return 'webp';
  return sourceType === 'image/png' ? 'png' : 'jpeg';
}

function sameAsSource(sourceType: string): OutputFormat {
  const sub = sourceType.split('/')[1];
  return FORMATS.has(sub as OutputFormat) ? (sub as OutputFormat) : 'jpeg';
}

export function parseResizeParams(
  query: Record<string, unknown>,
  limits: ResizeLimits,
  sourceType: string,
  accept: string | undefined,
): ResizeParams {
  const width = intParam(query.w, 'w', 1, limits.maxWidth);
  const height = intParam(query.h, 'h', 1, limits.maxHeight);
  if (width !== undefined && limits.allowedWidths && !limits.allowedWidths.includes(width)) {
    throw new HttpError(400, 'InvalidArgument', `w must be one of ${limits.allowedWidths.join(', ')}`);
  }
  if (height !== undefined && limits.allowedHeights && !limits.allowedHeights.includes(height)) {
    throw new HttpError(400, 'InvalidArgument', `h must be one of ${limits.allowedHeights.join(', ')}`);
  }
  const quality = intParam(query.q, 'q', 1, 100) ?? limits.defaultQuality;
  const fitRaw = query.fit ?? 'inside';
  if (typeof fitRaw !== 'string' || !FITS.has(fitRaw as Fit)) throw new HttpError(400, 'InvalidArgument', 'fit must be cover|contain|fill|inside|outside');
  const fmtRaw = query.format;
  let format: OutputFormat;
  let negotiated = false;
  if (fmtRaw === undefined || fmtRaw === '') format = sameAsSource(sourceType);
  else if (fmtRaw === 'auto') {
    format = negotiate(accept, sourceType);
    negotiated = true;
  } else if (typeof fmtRaw === 'string' && FORMATS.has((fmtRaw === 'jpg' ? 'jpeg' : fmtRaw) as OutputFormat)) {
    format = (fmtRaw === 'jpg' ? 'jpeg' : fmtRaw) as OutputFormat;
  } else throw new HttpError(400, 'InvalidArgument', 'format must be webp|avif|jpeg|png|auto');
  const p: ResizeParams = { fit: fitRaw as Fit, format, quality, negotiated };
  if (width !== undefined) p.width = width;
  if (height !== undefined) p.height = height;
  return p;
}

/** Cache key for a variant: changes whenever the source content (etag) changes. */
export function variantKey(bucket: string, key: string, sourceEtag: string, p: ResizeParams): string {
  return createHash('sha256')
    .update([bucket, key, sourceEtag, p.width ?? '', p.height ?? '', p.fit, p.format, p.quality].join('\0'))
    .digest('hex');
}
