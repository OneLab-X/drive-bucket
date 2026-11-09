import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../http/s3-error.js';

/** An access key the S3 API accepts. */
export interface S3Credential {
  accessKeyId: string;
  secretAccessKey: string;
  /** Buckets this key may touch. Default: all. */
  buckets?: string[] | '*';
  /** Deny writes (PUT/POST/DELETE). */
  readOnly?: boolean;
}

export interface SigV4Options {
  credentials: S3Credential[];
  /** Region clients must sign for. `auto` (default) accepts any region, like R2. */
  region?: string;
  /** Allowed clock skew. Default 15 minutes (same as S3). */
  maxSkewMs?: number;
  now?: () => number;
}

export interface SigV4Request {
  method: string;
  /** Raw request target as received (path + query, still percent-encoded). */
  rawUrl: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface AuthContext {
  credential: S3Credential;
  mode: 'header' | 'query';
  /** x-amz-content-sha256 value (or UNSIGNED-PAYLOAD for presigned). */
  payloadHash: string;
  signature: string;
  amzDate: string;
  scope: string;
  signingKey: Buffer;
}

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS does it: everything but A-Z a-z 0-9 - _ . ~ */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'InvalidURI', "Couldn't parse the specified URI.");
  }
}

export function splitUrl(rawUrl: string): { path: string; query: string } {
  const i = rawUrl.indexOf('?');
  return i < 0 ? { path: rawUrl, query: '' } : { path: rawUrl.slice(0, i), query: rawUrl.slice(i + 1) };
}

/** Parse a query string without URLSearchParams' `+` → space conversion. */
export function parseQuery(query: string): Array<[string, string]> {
  if (!query) return [];
  return query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? [safeDecode(part), ''] : [safeDecode(part.slice(0, i)), safeDecode(part.slice(i + 1))];
    });
}

export function canonicalUri(path: string): string {
  // S3 signs the path encoded once, without normalizing dot segments or duplicate slashes.
  return path
    .split('/')
    .map((seg) => uriEncode(safeDecode(seg)))
    .join('/') || '/';
}

export function canonicalQuery(params: Array<[string, string]>, exclude?: string): string {
  return params
    .filter(([k]) => k !== exclude)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function headerValue(headers: SigV4Request['headers'], name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v.join(',') : v).trim().replace(/\s+/g, ' ');
}

const keyCache = new Map<string, Buffer>();
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const cacheKey = `${createHash('sha256').update(secret).digest('hex')}/${date}/${region}/${service}`;
  let k = keyCache.get(cacheKey);
  if (!k) {
    k = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
    if (keyCache.size > 1000) keyCache.clear();
    keyCache.set(cacheKey, k);
  }
  return k;
}

function parseAmzDate(s: string | undefined): number {
  const m = s && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new HttpError(403, 'AccessDenied', 'AWS authentication requires a valid Date or x-amz-date header');
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function hasSigV4(req: SigV4Request): boolean {
  const auth = headerValue(req.headers, 'authorization');
  if (auth !== undefined) return true;
  return /(?:^|&)X-Amz-Signature=/i.test(splitUrl(req.rawUrl).query) || /(?:^|&)X-Amz-Algorithm=/i.test(splitUrl(req.rawUrl).query);
}

interface Parsed {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
  amzDate: string;
  payloadHash: string;
  mode: 'header' | 'query';
  expiresSec?: number;
}

function parseCredential(cred: string): { accessKeyId: string; date: string; region: string; service: string } {
  const parts = cred.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request') {
    throw new HttpError(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed; the Credential is mal-formed');
  }
  return { accessKeyId: parts[0]!, date: parts[1]!, region: parts[2]!, service: parts[3]! };
}

function parse(req: SigV4Request, params: Array<[string, string]>): Parsed {
  const auth = headerValue(req.headers, 'authorization');
  if (auth !== undefined) {
    if (!auth.startsWith(`${ALGORITHM} `)) {
      throw new HttpError(400, 'InvalidArgument', 'Unsupported Authorization Type; only AWS4-HMAC-SHA256 is supported');
    }
    const fields = Object.fromEntries(
      auth
        .slice(ALGORITHM.length + 1)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return [p.slice(0, i), p.slice(i + 1)];
        }),
    ) as Record<string, string>;
    if (!fields.Credential || !fields.SignedHeaders || !fields.Signature) {
      throw new HttpError(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed');
    }
    const payloadHash = headerValue(req.headers, 'x-amz-content-sha256');
    if (!payloadHash) throw new HttpError(400, 'InvalidRequest', 'Missing required header for this request: x-amz-content-sha256');
    const amzDate = headerValue(req.headers, 'x-amz-date');
    if (!amzDate) throw new HttpError(403, 'AccessDenied', 'AWS authentication requires a valid Date or x-amz-date header');
    return {
      ...parseCredential(fields.Credential),
      signedHeaders: fields.SignedHeaders.split(';'),
      signature: fields.Signature,
      amzDate,
      payloadHash,
      mode: 'header',
    };
  }
  const q = new Map(params);
  if (q.get('X-Amz-Algorithm') !== ALGORITHM) throw new HttpError(400, 'AuthorizationQueryParametersError', 'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"');
  const cred = q.get('X-Amz-Credential');
  const signed = q.get('X-Amz-SignedHeaders');
  const sig = q.get('X-Amz-Signature');
  const amzDate = q.get('X-Amz-Date');
  const expires = Number(q.get('X-Amz-Expires'));
  if (!cred || !signed || !sig || !amzDate || !Number.isInteger(expires)) {
    throw new HttpError(400, 'AuthorizationQueryParametersError', 'Query-string authentication requires X-Amz-Credential, X-Amz-SignedHeaders, X-Amz-Signature, X-Amz-Date and X-Amz-Expires');
  }
  if (expires < 1 || expires > MAX_PRESIGN_SECONDS) {
    throw new HttpError(400, 'AuthorizationQueryParametersError', 'X-Amz-Expires must be between 1 and 604800 seconds');
  }
  return {
    ...parseCredential(cred),
    signedHeaders: signed.split(';'),
    signature: sig,
    amzDate,
    payloadHash: q.get('X-Amz-Content-Sha256') ?? 'UNSIGNED-PAYLOAD',
    mode: 'query',
    expiresSec: expires,
  };
}

/** Verify an AWS Signature V4 request (header or presigned query). Throws S3-style HttpErrors. */
export function verifySigV4(req: SigV4Request, opts: SigV4Options): AuthContext {
  const { path, query } = splitUrl(req.rawUrl);
  const params = parseQuery(query);
  const p = parse(req, params);
  const now = (opts.now ?? Date.now)();
  const maxSkew = opts.maxSkewMs ?? 15 * 60 * 1000;

  const credential = opts.credentials.find((c) => c.accessKeyId === p.accessKeyId);
  if (!credential) throw new HttpError(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');
  if (p.service !== 's3') throw new HttpError(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed; incorrect service');
  const region = opts.region ?? 'auto';
  if (region !== 'auto' && p.region !== region) {
    throw new HttpError(400, 'AuthorizationHeaderMalformed', `The authorization header is malformed; the region '${p.region}' is wrong; expecting '${region}'`);
  }
  const t = parseAmzDate(p.amzDate);
  if (p.amzDate.slice(0, 8) !== p.date) throw new HttpError(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed; credential date does not match x-amz-date');
  if (p.mode === 'header') {
    if (Math.abs(now - t) > maxSkew) {
      throw new HttpError(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
    }
  } else {
    if (t - now > maxSkew) throw new HttpError(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
    if (now > t + p.expiresSec! * 1000) throw new HttpError(403, 'AccessDenied', 'Request has expired');
  }
  if (!p.signedHeaders.includes('host')) throw new HttpError(400, 'AuthorizationHeaderMalformed', 'Host must be a signed header');

  const canonicalHeaders = p.signedHeaders
    .map((h) => `${h}:${headerValue(req.headers, h) ?? ''}\n`)
    .join('');
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(path),
    canonicalQuery(params, p.mode === 'query' ? 'X-Amz-Signature' : undefined),
    canonicalHeaders,
    p.signedHeaders.join(';'),
    p.payloadHash,
  ].join('\n');
  const scope = `${p.date}/${p.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, p.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = signingKey(credential.secretAccessKey, p.date, p.region, 's3');
  const expected = createHmac('sha256', key).update(stringToSign).digest('hex');
  if (!safeEqualHex(expected, p.signature.toLowerCase())) {
    throw new HttpError(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.');
  }
  return { credential, mode: p.mode, payloadHash: p.payloadHash, signature: p.signature.toLowerCase(), amzDate: p.amzDate, scope, signingKey: key };
}

/** Signature of one aws-chunked chunk (STREAMING-AWS4-HMAC-SHA256-PAYLOAD). */
export function chunkSignature(ctx: Pick<AuthContext, 'signingKey' | 'amzDate' | 'scope'>, prev: string, data: Buffer): string {
  const sts = ['AWS4-HMAC-SHA256-PAYLOAD', ctx.amzDate, ctx.scope, prev, EMPTY_SHA256, sha256hex(data)].join('\n');
  return createHmac('sha256', ctx.signingKey).update(sts).digest('hex');
}

export function trailerSignature(ctx: Pick<AuthContext, 'signingKey' | 'amzDate' | 'scope'>, prev: string, trailer: string): string {
  const sts = ['AWS4-HMAC-SHA256-TRAILER', ctx.amzDate, ctx.scope, prev, sha256hex(trailer)].join('\n');
  return createHmac('sha256', ctx.signingKey).update(sts).digest('hex');
}

export { safeEqualHex, sha256hex };
