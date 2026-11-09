import { describe, expect, it } from 'vitest';
import { evaluateConditionals, ifRangeAllows } from '../src/http/conditional.js';
import { parseRange } from '../src/http/range.js';
import { s3ErrorXml, toS3Error } from '../src/http/s3-error.js';
import { NoSuchKey, QuotaExceeded, DriveApiError } from '@drivebucket/core';

describe('parseRange', () => {
  it.each([
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=5-', { start: 5 }],
    ['bytes=-20', { suffix: 20 }],
    [' Bytes = 1 - 2 ', { start: 1, end: 2 }],
  ])('%s', (h, want) => expect(parseRange(h)).toEqual(want));
  it.each([undefined, '', 'bytes=', 'bytes=-', 'bytes=9-1', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b'])('ignores %j', (h) =>
    expect(parseRange(h)).toBeUndefined(),
  );
});

describe('conditionals', () => {
  const v = { etag: '"abc"', lastModified: new Date('2026-01-01T00:00:00Z') };
  it.each([
    [{ 'if-none-match': '"abc"' }, 'not-modified'],
    [{ 'if-none-match': 'W/"abc"' }, 'not-modified'],
    [{ 'if-none-match': '"x", "abc"' }, 'not-modified'],
    [{ 'if-none-match': '*' }, 'not-modified'],
    [{ 'if-none-match': '"x"' }, 'ok'],
    [{ 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' }, 'not-modified'],
    [{ 'if-modified-since': 'Wed, 31 Dec 2025 00:00:00 GMT' }, 'ok'],
    [{ 'if-none-match': '"x"', 'if-modified-since': 'Fri, 02 Jan 2026 00:00:00 GMT' }, 'ok'],
    [{ 'if-match': '"abc"' }, 'ok'],
    [{ 'if-match': 'W/"abc"' }, 'precondition-failed'],
    [{ 'if-match': '"x"' }, 'precondition-failed'],
    [{ 'if-unmodified-since': 'Wed, 31 Dec 2025 00:00:00 GMT' }, 'precondition-failed'],
    [{ 'if-modified-since': 'garbage' }, 'ok'],
  ] as const)('%j -> %s', (h, want) => expect(evaluateConditionals(h as Record<string, string>, v)).toBe(want));

  it('If-Range', () => {
    expect(ifRangeAllows(undefined, v)).toBe(true);
    expect(ifRangeAllows('"abc"', v)).toBe(true);
    expect(ifRangeAllows('"old"', v)).toBe(false);
    expect(ifRangeAllows('W/"abc"', v)).toBe(false);
    expect(ifRangeAllows('Thu, 01 Jan 2026 00:00:00 GMT', v)).toBe(true);
    expect(ifRangeAllows('Fri, 02 Jan 2026 00:00:00 GMT', v)).toBe(false);
  });
});

describe('S3 errors', () => {
  it('maps typed errors and hides internals', () => {
    expect(toS3Error(new NoSuchKey('b', 'k'))).toMatchObject({ status: 404, code: 'NoSuchKey' });
    expect(toS3Error(new QuotaExceeded('drive full: user@x.com'))).toEqual({ status: 503, code: 'ServiceUnavailable', message: 'Storage quota exceeded' });
    expect(toS3Error(new DriveApiError('token=secret leaked', { status: 500 })).message).not.toContain('secret');
    expect(toS3Error(new Error('boom'))).toMatchObject({ status: 500, code: 'InternalError' });
  });
  it('escapes XML', () => {
    const xml = s3ErrorXml({ status: 404, code: 'NoSuchKey', message: 'a<b>&"' }, '/b/<k>', 'id');
    expect(xml).toContain('<Message>a&lt;b&gt;&amp;&quot;</Message>');
    expect(xml).toContain('<Resource>/b/&lt;k&gt;</Resource>');
    expect(xml.startsWith('<?xml')).toBe(true);
  });
});
