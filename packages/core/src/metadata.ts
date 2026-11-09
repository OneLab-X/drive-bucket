import { EntityTooLarge } from './errors.js';
import { keyHash, splitUtf8 } from './keys.js';

/**
 * appProperties layout (Drive: max 30 private props per app per file, 124 UTF-8 bytes per
 * property counting key + value):
 *
 *   drivebucket = "object" | "bucket" | "root"   marker
 *   b           = bucket name
 *   kh          = sha256(bucket \0 key), base64url  — the lookup key
 *   k0..k8      = object key in ≤120-byte chunks    (keys may be 1024 bytes)
 *   cc          = Cache-Control                     (if it fits)
 *   m.<name>    = user metadata                     (if everything fits)
 *   ms          = "1" when metadata/cacheControl spilled into `description` JSON
 */
export const PROP_MARKER = 'drivebucket';
export const PROP_BUCKET = 'b';
export const PROP_HASH = 'kh';
export const PROP_SPILL = 'ms';
export const PROP_CACHE = 'cc';
const KEY_CHUNK_PREFIX = 'k';
const META_PREFIX = 'm.';
const KEY_CHUNK_BYTES = 120;
const MAX_PROP_BYTES = 124;
const MAX_PROPS = 30;
/** Same as S3's user-defined metadata limit. */
export const MAX_METADATA_BYTES = 2048;

export type AppProperties = Record<string, string | null>;

export interface ObjectProps {
  bucket: string;
  key: string;
  metadata: Record<string, string>;
  cacheControl?: string;
}

export interface EncodedProps {
  appProperties: AppProperties;
  /** JSON to store in `description`; `null` clears a previous spill. */
  description: string | null;
}

function propBytes(k: string, v: string): number {
  return Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const [rawK, rawV] of Object.entries(metadata ?? {})) {
    const k = rawK.toLowerCase();
    const v = String(rawV);
    total += propBytes(k, v);
    out[k] = v;
  }
  if (total > MAX_METADATA_BYTES) {
    throw new EntityTooLarge(`User metadata is ${total} bytes; max is ${MAX_METADATA_BYTES}`);
  }
  return out;
}

/**
 * Build appProperties for an object. `previous` is the file's current appProperties (on
 * overwrite) so stale `m.*` / `k*` entries get cleared with nulls.
 */
export function encodeObjectProps(input: ObjectProps, previous?: Record<string, string> | null): EncodedProps {
  const metadata = normalizeMetadata(input.metadata);
  const props: AppProperties = {
    [PROP_MARKER]: 'object',
    [PROP_BUCKET]: input.bucket,
    [PROP_HASH]: keyHash(input.bucket, input.key),
  };
  splitUtf8(input.key, KEY_CHUNK_BYTES).forEach((chunk, i) => {
    props[`${KEY_CHUNK_PREFIX}${i}`] = chunk;
  });

  const metaEntries = Object.entries(metadata).map(([k, v]) => [`${META_PREFIX}${k}`, v] as const);
  const cacheFits = input.cacheControl === undefined || propBytes(PROP_CACHE, input.cacheControl) <= MAX_PROP_BYTES;
  const metaFits = metaEntries.every(([k, v]) => propBytes(k, v) <= MAX_PROP_BYTES);
  const countFits =
    Object.keys(props).length + metaEntries.length + (input.cacheControl !== undefined ? 1 : 0) <= MAX_PROPS;

  let description: string | null = null;
  if (cacheFits && metaFits && countFits) {
    if (input.cacheControl !== undefined) props[PROP_CACHE] = input.cacheControl;
    for (const [k, v] of metaEntries) props[k] = v;
  } else {
    props[PROP_SPILL] = '1';
    description = JSON.stringify({
      drivebucket: {
        metadata,
        ...(input.cacheControl !== undefined ? { cacheControl: input.cacheControl } : {}),
      },
    });
  }

  if (previous) {
    for (const k of Object.keys(previous)) {
      if (!(k in props)) props[k] = null;
    }
  }
  return { appProperties: props, description };
}

export function decodeObjectProps(
  appProperties: Record<string, string> | null | undefined,
  description?: string | null,
): ObjectProps | undefined {
  if (!appProperties || appProperties[PROP_MARKER] !== 'object') return undefined;
  const bucket = appProperties[PROP_BUCKET];
  if (bucket === undefined) return undefined;
  let key = '';
  for (let i = 0; ; i++) {
    const chunk = appProperties[`${KEY_CHUNK_PREFIX}${i}`];
    if (chunk === undefined) break;
    key += chunk;
  }
  if (key.length === 0) return undefined;

  let metadata: Record<string, string> = {};
  let cacheControl = appProperties[PROP_CACHE];
  if (appProperties[PROP_SPILL] === '1' && description) {
    try {
      const parsed = JSON.parse(description) as { drivebucket?: { metadata?: Record<string, string>; cacheControl?: string } };
      metadata = parsed.drivebucket?.metadata ?? {};
      cacheControl = parsed.drivebucket?.cacheControl ?? cacheControl;
    } catch {
      // Someone edited the description by hand. Treat as no metadata rather than failing reads.
    }
  } else {
    for (const [k, v] of Object.entries(appProperties)) {
      if (k.startsWith(META_PREFIX)) metadata[k.slice(META_PREFIX.length)] = v;
    }
  }
  return { bucket, key, metadata, ...(cacheControl !== undefined ? { cacheControl } : {}) };
}
