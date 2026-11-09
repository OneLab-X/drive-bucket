import { describe, expect, it, vi } from 'vitest';
import { AuthError, DailyUploadLimit, DriveApiError, ItemLimitExceeded, QuotaExceeded, RateLimited } from '../src/errors.js';
import { backoffDelay, parseRetryAfter, toDriveBucketError, withRetry } from '../src/retry.js';
import { httpError } from './fake-drive.js';

const fast = { sleep: async () => {}, random: () => 0 };

describe('withRetry', () => {
  it.each([
    [429, undefined],
    [403, 'rateLimitExceeded'],
    [403, 'userRateLimitExceeded'],
    [500, undefined],
    [503, 'backendError'],
  ])('retries %i %s then succeeds', async (status, reason) => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(status, reason)).mockResolvedValue('ok');
    await expect(withRetry(fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries network errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).mockResolvedValue(1);
    await expect(withRetry(fn, fast)).resolves.toBe(1);
  });

  it('gives up after 6 attempts with RateLimited', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(403, 'userRateLimitExceeded'));
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(RateLimited);
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it.each([
    [404, 'notFound', DriveApiError],
    [403, 'storageQuotaExceeded', QuotaExceeded],
    [403, 'insufficientFilePermissions', AuthError],
    [401, 'authError', AuthError],
    [403, 'numChildrenInNonRootLimitExceeded', ItemLimitExceeded],
  ])('does not retry %i %s', async (status, reason, cls) => {
    const fn = vi.fn().mockRejectedValue(httpError(status, reason));
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(cls);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry the daily upload limit', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(403, 'userRateLimitExceeded', { message: 'The user has exceeded their Drive upload limit' }));
    await expect(withRetry(fn, fast)).rejects.toBeInstanceOf(DailyUploadLimit);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After and reports retries', async () => {
    const sleeps: number[] = [];
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(httpError(429, undefined, { headers: { 'retry-after': '7' } })).mockResolvedValue('ok');
    await withRetry(fn, { sleep: async (ms) => void sleeps.push(ms), random: () => 0, onRetry });
    expect(sleeps).toEqual([7000]);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 7000 }));
  });

  it('reads Retry-After from a fetch Headers object', async () => {
    const err = httpError(429);
    (err as any).response.headers = new Headers({ 'Retry-After': '3' });
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue(1);
    await withRetry(fn, { sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    expect(sleeps).toEqual([3000]);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter and caps at 32s', () => {
    const o = { random: () => 0.5 };
    expect(backoffDelay(0, o)).toBe(1500);
    expect(backoffDelay(1, o)).toBe(2500);
    expect(backoffDelay(3, o)).toBe(8500);
    expect(backoffDelay(10, o)).toBe(32_000);
  });
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('nonsense')).toBeUndefined();
  });
  it('maps invalid_grant to AuthError', () => {
    const err = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    expect(toDriveBucketError(err)).toBeInstanceOf(AuthError);
  });
});
