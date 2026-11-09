import {
  AuthError,
  DailyUploadLimit,
  DriveApiError,
  DriveBucketError,
  ItemLimitExceeded,
  QuotaExceeded,
  RateLimited,
} from './errors.js';

export interface RetryOptions {
  /** Total attempts including the first. Default 6. */
  maxAttempts?: number;
  /** Base delay for attempt n: base * 2^n. Default 1000 ms (Drive docs: 2^n seconds). */
  baseDelayMs?: number;
  /** Cap per wait. Default 32 s (Drive docs: "typically 32 or 64 seconds"). */
  maxDelayMs?: number;
  /** Random jitter added to each wait, 0..jitterMs. Default 1000 ms. */
  jitterMs?: number;
  /** Called before each retry wait. Use for metrics/logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; reason?: string }) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ErrorInfo {
  status?: number;
  reason?: string;
  message: string;
  retryAfterMs?: number;
  network: boolean;
}

const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
  'transientError',
]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** Extract status / Drive reason / Retry-After from a gaxios error (or our own HTTP errors). */
export function errorInfo(err: unknown): ErrorInfo {
  const e = err as Record<string, any> | null | undefined;
  const response = e?.response as Record<string, any> | undefined;
  const statusRaw = response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  const status = typeof statusRaw === 'number' ? statusRaw : Number(statusRaw) || undefined;
  const data = response?.data;
  const firstErr =
    (Array.isArray(e?.errors) ? e.errors[0] : undefined) ??
    (data && typeof data === 'object' ? data.error?.errors?.[0] : undefined);
  const reason: string | undefined = firstErr?.reason ?? (data && typeof data === 'object' ? data.error?.status : undefined);
  const message: string =
    firstErr?.message ?? (data && typeof data === 'object' ? data.error?.message : undefined) ?? e?.message ?? String(err);
  const code = typeof e?.code === 'string' ? e.code : (e?.cause as any)?.code;
  const network = status === undefined && typeof code === 'string' && NETWORK_CODES.has(code);
  const retryAfterMs = parseRetryAfter(readHeader(response?.headers, 'retry-after'));
  const info: ErrorInfo = { message, network };
  if (status !== undefined) info.status = status;
  if (reason !== undefined) info.reason = reason;
  if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
  return info;
}

function looksLikeDailyUploadLimit(info: ErrorInfo): boolean {
  // Drive documents the 750 GB/day limit but no dedicated error reason. Match defensively.
  if (info.reason === 'uploadLimitExceeded' || info.reason === 'dailyUploadLimitExceeded') return true;
  return /upload limit|750\s?GB/i.test(info.message);
}

export function isRetryable(info: ErrorInfo): boolean {
  if (info.network) return true;
  if (info.status === undefined) return false;
  if (looksLikeDailyUploadLimit(info)) return false;
  if (info.status === 429) return true;
  if (info.status >= 500) return true;
  if (info.status === 403 && info.reason !== undefined && RETRYABLE_REASONS.has(info.reason)) return true;
  return false;
}

/**
 * Map a raw Drive error to a typed DriveBucketError. 404s are returned as DriveApiError with
 * status 404; callers that know the bucket/key convert them to NoSuchKey/NoSuchBucket.
 */
export function toDriveBucketError(err: unknown, context?: string): DriveBucketError {
  if (err instanceof DriveBucketError) return err;
  const info = errorInfo(err);
  const msg = context ? `${context}: ${info.message}` : info.message;
  const extra = { cause: err, ...(info.reason !== undefined ? { reason: info.reason } : {}) };
  if (looksLikeDailyUploadLimit(info)) return new DailyUploadLimit(msg, extra);
  switch (info.reason) {
    case 'storageQuotaExceeded':
    case 'quotaExceeded':
      return new QuotaExceeded(msg, extra);
    case 'numChildrenInNonRootLimitExceeded':
    case 'teamDriveFileLimitExceeded':
    case 'activeItemCreationLimitExceeded':
    case 'myDriveHierarchyDepthLimitExceeded':
    case 'teamDriveHierarchyTooDeep':
      return new ItemLimitExceeded(msg, extra);
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
    case 'dailyLimitExceeded':
    case 'sharingRateLimitExceeded':
      return new RateLimited(msg, {
        ...extra,
        ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
      });
    default:
      break;
  }
  if (info.status === 429) return new RateLimited(msg, extra);
  if (info.status === 401) return new AuthError(msg, { ...extra, status: 401 });
  if (info.status === 403) return new AuthError(msg, extra);
  // invalid_grant etc. from the OAuth token endpoint surface as 400 with no reason.
  if (/invalid_grant|invalid_client|unauthorized_client/i.test(info.message)) {
    return new AuthError(msg, { ...extra, status: 401 });
  }
  return new DriveApiError(msg, {
    status: info.status ?? 500,
    retryable: isRetryable(info),
    ...extra,
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, opts: RetryOptions, info?: ErrorInfo): number {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 32_000;
  const jitter = (opts.random ?? Math.random)() * (opts.jitterMs ?? 1000);
  const exp = Math.min(base * 2 ** attempt + jitter, max);
  // Retry-After wins when longer than our own backoff, but never park a request for > 2 min.
  if (info?.retryAfterMs !== undefined) return Math.min(Math.max(info.retryAfterMs, exp), 120_000);
  return exp;
}

/**
 * Run `fn` with exponential backoff + jitter on 429, 403 rate-limit reasons, 5xx and network
 * errors. Honors Retry-After. Throws a typed DriveBucketError on final failure.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}, context?: string): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof DriveBucketError && !err.retryable) throw err;
      const info = errorInfo(err);
      const retryable = err instanceof DriveBucketError ? err.retryable : isRetryable(info);
      if (!retryable || attempt + 1 >= maxAttempts) throw toDriveBucketError(err, context);
      const delayMs = backoffDelay(attempt, opts, info);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err, ...(info.reason ? { reason: info.reason } : {}) });
      await sleep(delayMs);
    }
  }
}
