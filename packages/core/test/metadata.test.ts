import { describe, expect, it } from 'vitest';
import { EntityTooLarge } from '../src/errors.js';
import { decodeObjectProps, encodeObjectProps } from '../src/metadata.js';

function assertDriveLimits(props: Record<string, string | null>) {
  const live = Object.entries(props).filter(([, v]) => v !== null) as [string, string][];
  expect(live.length).toBeLessThanOrEqual(30);
  for (const [k, v] of live) expect(Buffer.byteLength(k) + Buffer.byteLength(v)).toBeLessThanOrEqual(124);
}

describe('encode/decode object props', () => {
  it('round-trips a simple object with metadata in appProperties', () => {
    const enc = encodeObjectProps({ bucket: 'b', key: 'a/b.jpg', metadata: { Author: 'Ann' }, cacheControl: 'public, max-age=60' });
    assertDriveLimits(enc.appProperties);
    expect(enc.description).toBeNull();
    expect(enc.appProperties['m.author']).toBe('Ann');
    const dec = decodeObjectProps(enc.appProperties as Record<string, string>, null);
    expect(dec).toEqual({ bucket: 'b', key: 'a/b.jpg', metadata: { author: 'Ann' }, cacheControl: 'public, max-age=60' });
  });

  it('chunks a 1024-byte multibyte key within the 124-byte limit', () => {
    const key = 'ü'.repeat(512); // 1024 bytes
    const enc = encodeObjectProps({ bucket: 'b', key, metadata: {} });
    assertDriveLimits(enc.appProperties);
    expect(decodeObjectProps(enc.appProperties as Record<string, string>)?.key).toBe(key);
  });

  it('spills to description when a value is too long', () => {
    const enc = encodeObjectProps({ bucket: 'b', key: 'k', metadata: { note: 'x'.repeat(500) } });
    assertDriveLimits(enc.appProperties);
    expect(enc.appProperties.ms).toBe('1');
    expect(enc.description).toContain('xxxx');
    const dec = decodeObjectProps(enc.appProperties as Record<string, string>, enc.description);
    expect(dec?.metadata.note).toHaveLength(500);
  });

  it('spills when there are too many entries', () => {
    const metadata = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`k${i}`, 'v']));
    const enc = encodeObjectProps({ bucket: 'b', key: 'k', metadata });
    assertDriveLimits(enc.appProperties);
    expect(enc.appProperties.ms).toBe('1');
    expect(decodeObjectProps(enc.appProperties as Record<string, string>, enc.description)?.metadata).toEqual(metadata);
  });

  it('nulls out stale properties from the previous version', () => {
    const first = encodeObjectProps({ bucket: 'b', key: 'x'.repeat(300), metadata: { old: '1' } });
    const prev = Object.fromEntries(Object.entries(first.appProperties).filter(([, v]) => v !== null)) as Record<string, string>;
    const second = encodeObjectProps({ bucket: 'b', key: 'short', metadata: {} }, prev);
    expect(second.appProperties['m.old']).toBeNull();
    expect(second.appProperties.k2).toBeNull();
    expect(second.appProperties.k0).toBe('short');
  });

  it('rejects metadata over 2 KB', () => {
    expect(() => encodeObjectProps({ bucket: 'b', key: 'k', metadata: { big: 'x'.repeat(3000) } })).toThrow(EntityTooLarge);
  });

  it('ignores non-object files and corrupt descriptions', () => {
    expect(decodeObjectProps({ drivebucket: 'bucket', b: 'x' })).toBeUndefined();
    expect(decodeObjectProps(null)).toBeUndefined();
    const dec = decodeObjectProps({ drivebucket: 'object', b: 'b', k0: 'k', ms: '1' }, '{not json');
    expect(dec?.metadata).toEqual({});
  });
});
