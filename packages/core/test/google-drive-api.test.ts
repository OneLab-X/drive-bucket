import { describe, expect, it } from 'vitest';
import type { AuthClient } from '../src/auth.js';
import { createAuthClient } from '../src/auth.js';
import { GoogleDriveApi, parseReceived } from '../src/drive-api.js';
import { ConfigError } from '../src/errors.js';

interface Captured {
  url: string;
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  data?: unknown;
}

/** Auth client stub: googleapis routes every API call through `authClient.request`. */
function fakeAuth(respond: (req: Captured) => { status: number; headers?: Record<string, string>; data?: unknown }) {
  const calls: Captured[] = [];
  const auth = {
    async request(opts: Captured) {
      calls.push(opts);
      const r = respond(opts);
      if (r.status >= 400) throw Object.assign(new Error('http'), { response: { status: r.status, headers: r.headers ?? {}, data: r.data } });
      return { status: r.status, headers: new Headers(r.headers ?? {}), data: r.data ?? {} };
    },
  };
  return { auth: auth as unknown as AuthClient, calls };
}

function fullUrl(c: Captured): URL {
  const u = new URL(c.url);
  for (const [k, v] of Object.entries(c.params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  return u;
}

describe('GoogleDriveApi request shapes', () => {
  it('always sends supportsAllDrives and scopes list to corpora=user in My Drive', async () => {
    const { auth, calls } = fakeAuth(() => ({ status: 200, data: { files: [{ id: '1' }], nextPageToken: 'n' } }));
    const api = new GoogleDriveApi({ auth });
    const res = await api.listFiles({ q: "trashed=false", fields: 'files(id)', pageSize: 5 });
    expect(res).toEqual({ files: [{ id: '1' }], nextPageToken: 'n' });
    const u = fullUrl(calls[0]!);
    expect(u.pathname).toBe('/drive/v3/files');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(u.searchParams.get('corpora')).toBe('user');
    expect(u.searchParams.get('q')).toBe('trashed=false');
  });

  it('uses corpora=drive + driveId for a shared drive', async () => {
    const { auth, calls } = fakeAuth(() => ({ status: 200, data: { files: [] } }));
    await new GoogleDriveApi({ auth, sharedDriveId: 'sd1' }).listFiles({ q: 'x', fields: 'files(id)' });
    const u = fullUrl(calls[0]!);
    expect(u.searchParams.get('corpora')).toBe('drive');
    expect(u.searchParams.get('driveId')).toBe('sd1');
  });

  it('downloads with alt=media and a Range header', async () => {
    const { auth, calls } = fakeAuth(() => ({ status: 206, data: 'stream' }));
    await new GoogleDriveApi({ auth }).getMedia('fid', { start: 5, end: 9 });
    const c = calls[0]!;
    const u = fullUrl(c);
    expect(u.pathname).toBe('/drive/v3/files/fid');
    expect(u.searchParams.get('alt')).toBe('media');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    const h = new Headers(c.headers);
    expect(h.get('range')).toBe('bytes=5-9');
    expect(h.get('accept-encoding')).toBe('identity');
  });

  it('starts resumable sessions (POST for create, PATCH for update) and reads Location', async () => {
    const { auth, calls } = fakeAuth(() => ({ status: 200, headers: { location: 'https://upload/session1' } }));
    const api = new GoogleDriveApi({ auth });
    const uri = await api.startResumable({ meta: { name: 'a' }, contentType: 'image/png', contentLength: 10, fields: 'id' });
    expect(uri).toBe('https://upload/session1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('uploadType=resumable');
    expect(calls[0]!.url).toContain('supportsAllDrives=true');
    expect(calls[0]!.headers).toMatchObject({ 'X-Upload-Content-Type': 'image/png', 'X-Upload-Content-Length': '10' });
    await api.startResumable({ fileId: 'f1', meta: {}, contentType: 'x/y', fields: 'id' });
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toContain('/upload/drive/v3/files/f1?');
  });

  it('maps 308 + Range to progress and 200 to completion', async () => {
    let n = 0;
    const { auth, calls } = fakeAuth(() =>
      n++ === 0 ? { status: 308, headers: { range: 'bytes=0-262143' } } : { status: 200, data: { id: 'done', md5Checksum: 'abc' } },
    );
    const api = new GoogleDriveApi({ auth });
    expect(await api.putChunk('https://s', Buffer.alloc(262144), 0, undefined)).toEqual({ done: false, received: 262144 });
    expect(calls[0]!.headers!['Content-Range']).toBe('bytes 0-262143/*');
    expect(await api.putChunk('https://s', Buffer.alloc(10), 262144, 262154)).toEqual({ done: true, file: { id: 'done', md5Checksum: 'abc' } });
    expect(calls[1]!.headers!['Content-Range']).toBe('bytes 262144-262153/262154');
  });

  it('queries upload status with an empty PUT', async () => {
    const { auth, calls } = fakeAuth(() => ({ status: 308 }));
    expect(await new GoogleDriveApi({ auth }).queryResumable('https://s', undefined)).toEqual({ done: false, received: 0 });
    expect(calls[0]!.headers!['Content-Range']).toBe('bytes */*');
  });

  it('parseReceived handles absent and present Range', () => {
    expect(parseReceived(undefined)).toBe(0);
    expect(parseReceived('bytes=0-42')).toBe(43);
  });
});

describe('createAuthClient', () => {
  it('validates oauth config', () => {
    expect(() => createAuthClient({ type: 'oauthRefreshToken', clientId: '', clientSecret: 's', refreshToken: 'r' })).toThrow(ConfigError);
    expect(createAuthClient({ type: 'oauthRefreshToken', clientId: 'c', clientSecret: 's', refreshToken: 'r' })).toBeTruthy();
  });
  it('validates service account config', () => {
    expect(() => createAuthClient({ type: 'serviceAccount' })).toThrow(ConfigError);
    expect(createAuthClient({ type: 'serviceAccount', keyFile: '/tmp/x.json', subject: 'u@x.com' }, 'drive')).toBeTruthy();
  });
});
