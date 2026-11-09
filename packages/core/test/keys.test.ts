import { describe, expect, it } from 'vitest';
import { InvalidBucketName, InvalidKey } from '../src/errors.js';
import { escapeQuery, fileNameForKey, keyHash, splitUtf8, validateBucketName, validateKey } from '../src/keys.js';

describe('validateKey', () => {
  it.each(['a', 'photos/2026/cat.jpg', 'dir/', 'ünïcødé/文件.txt', 'a'.repeat(1024), 'a..b', '.hidden'])('accepts %j', (k) => {
    expect(() => validateKey(k)).not.toThrow();
  });
  it.each([
    ['', 'empty'],
    ['a'.repeat(1025), 'too long'],
    ['é'.repeat(513), 'too many bytes'],
    ['../etc/passwd', 'dotdot'],
    ['a/../b', 'dotdot middle'],
    ['a/./b', 'dot segment'],
    ['/abs', 'leading slash'],
    ['a\u0000b', 'nul'],
    ['a\nb', 'newline'],
    ['\ud800', 'lone surrogate'],
  ])('rejects %j (%s)', (k) => {
    expect(() => validateKey(k)).toThrow(InvalidKey);
  });
});

describe('validateBucketName', () => {
  it.each(['photos', 'my-bucket.v2', 'abc'])('accepts %s', (b) => expect(() => validateBucketName(b)).not.toThrow());
  it.each(['ab', 'UPPER', '-bad', 'bad-', 'a..b', '192.168.0.1', 'a'.repeat(64), 'under_score'])('rejects %s', (b) =>
    expect(() => validateBucketName(b)).toThrow(InvalidBucketName),
  );
});

describe('helpers', () => {
  it('keyHash is stable, bucket-scoped and fits a property', () => {
    expect(keyHash('b1', 'k')).toBe(keyHash('b1', 'k'));
    expect(keyHash('b1', 'k')).not.toBe(keyHash('b2', 'k'));
    expect(keyHash('ab', 'c')).not.toBe(keyHash('a', 'bc'));
    expect(keyHash('b', 'k')).toHaveLength(43);
  });
  it('fileNameForKey uses the last segment', () => {
    expect(fileNameForKey('a/b/c.jpg')).toBe('c.jpg');
    expect(fileNameForKey('c.jpg')).toBe('c.jpg');
    expect(fileNameForKey('a/b/')).toBe('b');
  });
  it('splitUtf8 never splits a code point and respects the byte cap', () => {
    const s = '😀'.repeat(100) + 'abc';
    const parts = splitUtf8(s, 10);
    expect(parts.join('')).toBe(s);
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(10);
  });
  it('escapeQuery escapes quotes and backslashes', () => {
    expect(escapeQuery("it's a \\ test")).toBe("it\\'s a \\\\ test");
  });
});
