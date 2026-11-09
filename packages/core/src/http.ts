/** Framework-neutral HTTP helpers shared by @drivebucket/server and @drivebucket/next. */
import type { ByteRange } from './types.js';

/**
 * Parse a single-range `Range` header. Returns undefined for absent, malformed or multi-range
 * headers (RFC 9110 lets a server ignore those and send 200 with the full body).
 */
export function parseRange(header: string | undefined): ByteRange | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') return { suffix: Number(b) };
  const start = Number(a);
  if (b === '') return { start };
  const end = Number(b);
  if (end < start) return undefined;
  return { start, end };
}

/** RFC 9110 §13 conditional request evaluation for GET/HEAD. */

export interface Validators {
  /** Quoted strong ETag, e.g. `"abc"`. */
  etag: string;
  lastModified: Date;
}

export type ConditionalResult = 'ok' | 'not-modified' | 'precondition-failed';

function parseEtagList(header: string): string[] {
  return header.split(',').map((s) => s.trim()).filter(Boolean);
}

function opaque(tag: string): string {
  return tag.replace(/^W\//, '');
}

/** Weak comparison (If-None-Match). */
function weakMatch(header: string, etag: string): boolean {
  return parseEtagList(header).some((t) => t === '*' || opaque(t) === opaque(etag));
}

/** Strong comparison (If-Match, If-Range). */
function strongMatch(header: string, etag: string): boolean {
  return parseEtagList(header).some((t) => t === '*' || (!t.startsWith('W/') && t === etag));
}

function seconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function parseDate(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

export function evaluateConditionals(headers: Record<string, string | string[] | undefined>, v: Validators): ConditionalResult {
  const h = (n: string) => {
    const x = headers[n];
    return Array.isArray(x) ? x.join(',') : x;
  };
  const ifMatch = h('if-match');
  if (ifMatch !== undefined) {
    if (!strongMatch(ifMatch, v.etag)) return 'precondition-failed';
  } else {
    const ius = parseDate(h('if-unmodified-since'));
    if (ius !== undefined && seconds(v.lastModified) > ius) return 'precondition-failed';
  }
  const inm = h('if-none-match');
  if (inm !== undefined) {
    if (weakMatch(inm, v.etag)) return 'not-modified';
  } else {
    const ims = parseDate(h('if-modified-since'));
    if (ims !== undefined && seconds(v.lastModified) <= ims) return 'not-modified';
  }
  return 'ok';
}

/** Whether a Range header should be honoured given If-Range. */
export function ifRangeAllows(ifRange: string | undefined, v: Validators): boolean {
  if (!ifRange) return true;
  const trimmed = ifRange.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('W/')) return strongMatch(trimmed, v.etag);
  const d = parseDate(trimmed);
  return d !== undefined && seconds(v.lastModified) === d;
}
