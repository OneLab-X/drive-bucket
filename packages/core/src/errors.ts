/**
 * Typed errors. Every error thrown by drivebucket extends DriveBucketError and carries a
 * stable `code` (S3-style where one exists) plus the HTTP status the server layer should use.
 */
export class DriveBucketError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  /** Drive error reason (e.g. `userRateLimitExceeded`) when the error came from Drive. */
  readonly reason?: string;

  constructor(
    message: string,
    opts: { code: string; status: number; retryable?: boolean; reason?: string; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.reason !== undefined) this.reason = opts.reason;
  }
}

type Extra = { reason?: string; cause?: unknown };

export class NoSuchKey extends DriveBucketError {
  readonly bucket: string;
  readonly key: string;
  constructor(bucket: string, key: string, extra: Extra = {}) {
    super(`No such key: ${bucket}/${key}`, { code: 'NoSuchKey', status: 404, ...extra });
    this.bucket = bucket;
    this.key = key;
  }
}

export class NoSuchBucket extends DriveBucketError {
  readonly bucket: string;
  constructor(bucket: string, extra: Extra = {}) {
    super(`No such bucket: ${bucket}`, { code: 'NoSuchBucket', status: 404, ...extra });
    this.bucket = bucket;
  }
}

export class BucketAlreadyExists extends DriveBucketError {
  constructor(bucket: string) {
    super(`Bucket already exists: ${bucket}`, { code: 'BucketAlreadyOwnedByYou', status: 409 });
  }
}

export class InvalidKey extends DriveBucketError {
  constructor(message: string) {
    super(message, { code: 'InvalidKey', status: 400 });
  }
}

export class InvalidBucketName extends DriveBucketError {
  constructor(message: string) {
    super(message, { code: 'InvalidBucketName', status: 400 });
  }
}

export class InvalidRange extends DriveBucketError {
  constructor(message = 'The requested range is not satisfiable') {
    super(message, { code: 'InvalidRange', status: 416 });
  }
}

export class PreconditionFailed extends DriveBucketError {
  constructor(message = 'At least one of the preconditions you specified did not hold') {
    super(message, { code: 'PreconditionFailed', status: 412 });
  }
}

/** Content-MD5 (or another client-supplied digest) did not match the body. */
export class BadDigest extends DriveBucketError {
  constructor(message = 'The Content-MD5 you specified did not match what we received') {
    super(message, { code: 'BadDigest', status: 400 });
  }
}

export class EntityTooLarge extends DriveBucketError {
  constructor(message: string) {
    super(message, { code: 'EntityTooLarge', status: 400 });
  }
}

/** Drive storage is full (`storageQuotaExceeded`), or a service account tried to own files. */
export class QuotaExceeded extends DriveBucketError {
  constructor(message: string, extra: Extra = {}) {
    super(message, { code: 'QuotaExceeded', status: 507, ...extra });
  }
}

/** Per-minute/per-user rate limit still exceeded after all retries. */
export class RateLimited extends DriveBucketError {
  readonly retryAfterMs?: number;
  constructor(message: string, extra: Extra & { retryAfterMs?: number } = {}) {
    super(message, { code: 'SlowDown', status: 503, retryable: true, ...extra });
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** The 750 GB/day per-user upload (and copy) limit. Lifts 24 h after it trips. */
export class DailyUploadLimit extends DriveBucketError {
  constructor(message: string, extra: Extra = {}) {
    super(message, { code: 'DailyUploadLimit', status: 503, ...extra });
  }
}

/** Drive structural limit: 500k items per folder / shared drive, 500M items per user, etc. */
export class ItemLimitExceeded extends DriveBucketError {
  constructor(message: string, extra: Extra = {}) {
    super(message, { code: 'ItemLimitExceeded', status: 507, ...extra });
  }
}

export class AuthError extends DriveBucketError {
  constructor(message: string, extra: Extra & { status?: number } = {}) {
    super(message, { code: 'AccessDenied', status: extra.status ?? 403, ...extra });
  }
}

/** Misconfiguration detected at startup (bad shared drive, missing credentials, ...). */
export class ConfigError extends DriveBucketError {
  constructor(message: string, extra: Extra = {}) {
    super(message, { code: 'ConfigError', status: 500, ...extra });
  }
}

/** Any other Drive failure. */
export class DriveApiError extends DriveBucketError {
  constructor(message: string, opts: { status: number; retryable?: boolean } & Extra) {
    super(message, { code: 'InternalError', ...opts });
  }
}

export function isDriveBucketError(err: unknown): err is DriveBucketError {
  return err instanceof DriveBucketError;
}
