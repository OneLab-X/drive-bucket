import { createHash } from 'node:crypto';
import { InvalidBucketName, InvalidKey } from './errors.js';

export const MAX_KEY_BYTES = 1024;

/** Validate an object key: 1..1024 UTF-8 bytes, no `..`/`.` segments, no control chars. */
export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidKey('Key must be a non-empty string');
  if (!key.isWellFormed()) throw new InvalidKey('Key must be valid UTF-8');
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_KEY_BYTES) throw new InvalidKey(`Key is ${bytes} bytes; max is ${MAX_KEY_BYTES}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new InvalidKey('Key must not contain control characters');
  if (key.startsWith('/')) throw new InvalidKey('Key must not start with "/"');
  for (const seg of key.split('/')) {
    if (seg === '..' || seg === '.') throw new InvalidKey('Key must not contain "." or ".." path segments');
  }
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** S3 bucket naming rules (subset): 3-63 chars, lowercase letters, digits, dots, hyphens. */
export function validateBucketName(bucket: unknown): asserts bucket is string {
  if (typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) {
    throw new InvalidBucketName(
      'Bucket name must be 3-63 chars of lowercase letters, digits, "." or "-", starting and ending with a letter or digit',
    );
  }
  if (bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw new InvalidBucketName('Bucket name must not contain ".." or look like an IP address');
  }
}

/** Stable lookup hash for (bucket, key). 43 chars base64url, fits in one appProperty. */
export function keyHash(bucket: string, key: string): string {
  return createHash('sha256').update(bucket).update('\0').update(key).digest('base64url');
}

/** Drive file name for a key: its last path segment (or the whole key if it ends in "/"). */
export function fileNameForKey(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf('/');
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name.length > 0 ? name : key;
}

/** Split a string into pieces of at most `maxBytes` UTF-8 bytes without splitting code points. */
export function splitUtf8(value: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of value) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > maxBytes) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/** Escape a value for use inside a single-quoted Drive `q` string. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
