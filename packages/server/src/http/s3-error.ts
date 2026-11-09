import { AuthError, DriveApiError, DriveBucketError, isDriveBucketError } from '@drivebucket/core';

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export interface S3ErrorBody {
  status: number;
  code: string;
  message: string;
}

/** S3 error codes for drivebucket error codes that differ. */
const CODE_MAP: Record<string, string> = {
  InvalidKey: 'InvalidArgument',
  QuotaExceeded: 'ServiceUnavailable',
  DailyUploadLimit: 'ServiceUnavailable',
  ItemLimitExceeded: 'ServiceUnavailable',
  ConfigError: 'InternalError',
  IncompleteBody: 'IncompleteBody',
};

export class HttpError extends DriveBucketError {
  constructor(status: number, code: string, message: string) {
    super(message, { code, status });
  }
}

/** Convert anything thrown into an S3-shaped error. Internal details never reach the client. */
export function toS3Error(err: unknown): S3ErrorBody {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  // Failures talking to Drive (bad request, revoked token, missing permission) are server-side
  // problems: never forward Drive's message, which can contain ids, emails or tokens.
  if (err instanceof DriveApiError || err instanceof AuthError) {
    return err.retryable
      ? { status: 503, code: 'ServiceUnavailable', message: 'Service temporarily unavailable. Please retry.' }
      : { status: 500, code: 'InternalError', message: 'We encountered an internal error. Please try again.' };
  }
  if (isDriveBucketError(err)) {
    const status = err.status;
    if (status >= 500 && !(err.code === 'SlowDown' || err.code === 'QuotaExceeded' || err.code === 'DailyUploadLimit' || err.code === 'ItemLimitExceeded')) {
      return { status: 500, code: 'InternalError', message: 'We encountered an internal error. Please try again.' };
    }
    const message =
      err.code === 'QuotaExceeded'
        ? 'Storage quota exceeded'
        : err.code === 'DailyUploadLimit'
          ? 'Daily upload limit reached; retry in 24 hours'
          : err.code === 'ItemLimitExceeded'
            ? 'Storage item limit reached'
            : err.code === 'SlowDown'
              ? 'Please reduce your request rate.'
              : err.message;
    const s3Status = CODE_MAP[err.code] === 'ServiceUnavailable' ? 503 : status;
    return { status: s3Status, code: CODE_MAP[err.code] ?? err.code, message };
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return { status: e.statusCode, code: 'InvalidRequest', message: e.message ?? 'Invalid request' };
  }
  return { status: 500, code: 'InternalError', message: 'We encountered an internal error. Please try again.' };
}

export function s3ErrorXml(e: S3ErrorBody, resource: string, requestId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Error><Code>${xmlEscape(e.code)}</Code><Message>${xmlEscape(e.message)}</Message>` +
    `<Resource>${xmlEscape(resource)}</Resource><RequestId>${xmlEscape(requestId)}</RequestId></Error>`
  );
}

