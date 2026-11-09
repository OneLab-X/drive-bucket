import { createHmac } from 'node:crypto';
import { ALGORITHM, canonicalQuery, canonicalUri, sha256hex, signingKey, uriEncode } from './sigv4.js';

export interface PresignOptions {
  /** Public base URL of the server, e.g. https://files.example.com */
  endpoint: string;
  bucket: string;
  key: string;
  method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  accessKeyId: string;
  secretAccessKey: string;
  /** Default us-east-1 (any region works with region=auto on the server). */
  region?: string;
  /** Seconds, 1..604800. Default 900. */
  expiresIn?: number;
  /** Extra query params to sign, e.g. response-content-disposition. */
  query?: Record<string, string>;
  now?: Date;
}

function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Presign a path-style URL (SigV4 query auth, UNSIGNED-PAYLOAD, only `host` signed).
 * Equivalent to @aws-sdk/s3-request-presigner without the SDK.
 */
export function presignUrl(o: PresignOptions): string {
  const base = new URL(o.endpoint);
  const region = o.region ?? 'us-east-1';
  const now = o.now ?? new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const expires = o.expiresIn ?? 900;
  if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) throw new RangeError('expiresIn must be 1..604800 seconds');
  const prefix = base.pathname.replace(/\/$/, '');
  const path = `${prefix}/${uriEncode(o.bucket)}/${o.key.split('/').map(uriEncode).join('/')}`;
  const scope = `${day}/${region}/s3/aws4_request`;
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${o.accessKeyId}/${scope}`],
    ['X-Amz-Date', date],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
    ...Object.entries(o.query ?? {}),
  ];
  const canonical = [o.method ?? 'GET', canonicalUri(path), canonicalQuery(params), `host:${base.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = [ALGORITHM, date, scope, sha256hex(canonical)].join('\n');
  const sig = createHmac('sha256', signingKey(o.secretAccessKey, day, region, 's3')).update(sts).digest('hex');
  return `${base.protocol}//${base.host}${path}?${canonicalQuery([...params, ['X-Amz-Signature', sig]])}`;
}
