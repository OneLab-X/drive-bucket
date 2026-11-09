import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DriveAdapter } from '@drivebucket/core';
import { FakeDrive, httpError } from '@drivebucket/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guessType, parseDbUrl, parseEnvFile, run, type Io } from '../src/cli.js';
import { oauthLogin, type OAuthClientLike } from '../src/login.js';

const OAUTH_ENV = { DRIVEBUCKET_CLIENT_ID: 'cid', DRIVEBUCKET_CLIENT_SECRET: 'csecret', DRIVEBUCKET_REFRESH_TOKEN: 'rtoken' };

let dir: string;
let fake: FakeDrive;
let adapter: DriveAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dbcli-'));
  fake = new FakeDrive();
  adapter = new DriveAdapter({ api: fake, retry: { sleep: async () => {}, random: () => 0 } });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function cli(argv: string[], over: Partial<Io> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let o = '';
  let e = '';
  stdout.on('data', (c) => (o += c));
  stderr.on('data', (c) => (e += c));
  const code = await run(argv, {
    stdout,
    stderr,
    stdin: Readable.from([]),
    env: OAUTH_ENV,
    cwd: dir,
    createAdapter: () => adapter,
    grantedScopes: async () => ['https://www.googleapis.com/auth/drive.file'],
    ...over,
  });
  return { code, out: o, err: e };
}

describe('helpers', () => {
  it('parseDbUrl', () => {
    expect(parseDbUrl('db://photos/a/b.jpg')).toEqual({ bucket: 'photos', key: 'a/b.jpg' });
    expect(parseDbUrl('db://photos')).toEqual({ bucket: 'photos', key: '' });
    expect(parseDbUrl('./local')).toBeUndefined();
  });
  it('parseEnvFile', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=val # comment\nE="l1\\nl2"\nbad line')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val', E: 'l1\nl2' });
  });
  it('guessType', () => {
    expect(guessType('a/B.JPG')).toBe('image/jpeg');
    expect(guessType('x.unknown')).toBe('application/octet-stream');
  });
});

describe('help and usage', () => {
  it('prints help and version; usage errors exit 2', async () => {
    expect((await cli(['--help'])).out).toContain('Usage: drivebucket');
    expect((await cli(['--version'])).code).toBe(0);
    expect((await cli([])).code).toBe(2);
    const bad = await cli(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('Unknown command');
    expect((await cli(['cp', 'a'])).code).toBe(2);
  });

  it('loads --env-file (process env wins)', async () => {
    await writeFile(join(dir, '.env'), 'DRIVEBUCKET_CLIENT_ID=from-file\nDRIVEBUCKET_CLIENT_SECRET=s\nDRIVEBUCKET_REFRESH_TOKEN=r\n');
    let seen: unknown;
    const r = await cli(['--env-file', '.env', 'buckets', 'ls'], {
      env: {},
      createAdapter: (o) => {
        seen = o.auth;
        return adapter;
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toMatchObject({ clientId: 'from-file' });
  });

  it('reports missing credentials clearly', async () => {
    const r = await cli(['buckets', 'ls'], { env: {}, createAdapter: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No Google credentials');
  });
});

describe('buckets, cp, ls, rm', () => {
  it('end to end with local files, directories and stdin/stdout', async () => {
    expect((await cli(['buckets', 'create', 'photos'])).code).toBe(0);
    expect((await cli(['buckets', 'ls'])).out).toContain('photos');

    await writeFile(join(dir, 'cat.jpg'), 'meow');
    await mkdir(join(dir, 'album/sub'), { recursive: true });
    await writeFile(join(dir, 'album/a.png'), 'a');
    await writeFile(join(dir, 'album/sub/b.txt'), 'b');

    expect((await cli(['cp', 'cat.jpg', 'db://photos/'])).code).toBe(0);
    expect((await adapter.head('photos', 'cat.jpg')).contentType).toBe('image/jpeg');
    expect((await cli(['cp', 'album', 'db://photos/albums/x'])).code).toBe(2);
    const up = await cli(['cp', '-r', 'album', 'db://photos/albums/x', '--cache-control', 'max-age=60']);
    expect(up.code).toBe(0);
    expect(up.err).toContain('2 file(s) uploaded');
    expect((await adapter.head('photos', 'albums/x/sub/b.txt')).cacheControl).toBe('max-age=60');
    expect((await cli(['cp', '-', 'db://photos/stdin.txt'], { stdin: Readable.from([Buffer.from('piped')]) })).code).toBe(0);

    const ls = await cli(['ls', 'db://photos/']);
    expect(ls.out).toMatch(/PRE\s+albums\//);
    expect(ls.out).toMatch(/4 B\s+cat\.jpg/);
    const lsr = await cli(['ls', '-r', '--json', 'db://photos/albums/']);
    expect(JSON.parse(lsr.out).map((r: { key: string }) => r.key)).toEqual(['albums/x/a.png', 'albums/x/sub/b.txt']);

    const cat = await cli(['cp', 'db://photos/stdin.txt', '-']);
    expect(cat.out).toBe('piped');
    await mkdir(join(dir, 'dl'));
    expect((await cli(['cp', 'db://photos/cat.jpg', 'dl'])).code).toBe(0);
    expect(await readFile(join(dir, 'dl/cat.jpg'), 'utf8')).toBe('meow');
    expect((await cli(['cp', '-r', 'db://photos/albums', 'restore'])).code).toBe(0);
    expect(await readFile(join(dir, 'restore/x/sub/b.txt'), 'utf8')).toBe('b');

    expect((await cli(['cp', 'db://photos/cat.jpg', 'db://photos/copy/'])).code).toBe(0);
    expect((await adapter.head('photos', 'copy/cat.jpg')).size).toBe(4);

    expect((await cli(['rm', 'db://photos/cat.jpg'])).code).toBe(0);
    expect((await cli(['rm', 'db://photos/cat.jpg'])).code).toBe(1);
    const rmr = await cli(['rm', '-r', '--permanent', 'db://photos/albums/']);
    expect(rmr.err).toContain('2 object(s) deleted');
    expect((await cli(['rm', '-r', 'db://photos'])).code).toBe(2);
    expect((await cli(['buckets', 'rm', 'photos'])).code).toBe(1);
  });

  it('surfaces typed errors with exit 1', async () => {
    const r = await cli(['ls', 'db://nope/']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('NoSuchBucket');
  });
});

describe('doctor', () => {
  it('all green on a healthy setup, with a write test', async () => {
    await adapter.createBucket('photos');
    const r = await cli(['doctor', '--write-test', 'photos']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/✓ credentials\s+signed in as tester@example.com/);
    expect(r.out).toMatch(/✓ storage quota/);
    expect(r.out).toMatch(/✓ scopes\s+drive\.file/);
    expect(r.out).toMatch(/✓ buckets\s+photos/);
    expect(r.out).toMatch(/✓ write test/);
  });

  it('flags revoked tokens with the Testing-mode hint, near-full quota and missing scope', async () => {
    fake.failNext('getAbout', Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }));
    const r1 = await cli(['doctor', '--json']);
    expect(r1.code).toBe(1);
    const c1 = JSON.parse(r1.out);
    expect(c1.find((c: { name: string }) => c.name === 'credentials')).toMatchObject({ status: 'fail' });
    expect(c1.find((c: { name: string }) => c.name === 'credentials').detail).toContain('7 days');

    fake.about = { email: 'x@y.z', limit: 100, usage: 95 };
    const r2 = await cli(['doctor'], { env: { ...OAUTH_ENV, DRIVEBUCKET_SCOPE: 'drive' } });
    expect(r2.out).toMatch(/! storage quota/);
    expect(r2.out).toMatch(/✗ scopes\s+DRIVEBUCKET_SCOPE=drive but the token only has drive.file/);
    expect(r2.code).toBe(1);
  });

  it('checks shared drive membership', async () => {
    fake.addSharedDrive('sd-ok');
    const ok = await cli(['doctor'], {
      env: { ...OAUTH_ENV, DRIVEBUCKET_SHARED_DRIVE_ID: 'sd-ok' },
      createAdapter: (o) => new DriveAdapter({ ...o, api: fake }),
    });
    expect(ok.out).toMatch(/✓ shared drive/);
    const bad = await cli(['doctor'], {
      env: { ...OAUTH_ENV, DRIVEBUCKET_SHARED_DRIVE_ID: 'sd-missing' },
      createAdapter: (o) => new DriveAdapter({ ...o, api: fake }),
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/✗ shared drive\s+sd-missing not accessible/);
  });

  it('reports config errors as a failed check', async () => {
    const r = await cli(['doctor'], { env: {}, createAdapter: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ config/);
  });

  it('explains a disabled Drive API', async () => {
    fake.failNext('getAbout', httpError(403, 'accessNotConfigured', { message: 'Google Drive API has not been used in project 123 before or it is disabled.' }));
    const r = await cli(['doctor']);
    expect(r.out).toContain('Enable the Google Drive API');
  });
});

describe('auth login (loopback + PKCE)', () => {
  function fakeOAuth(tokens: { refresh_token?: string; scope?: string } = { refresh_token: 'NEW_REFRESH', scope: 'https://www.googleapis.com/auth/drive.file' }) {
    const calls: { authUrl?: Record<string, unknown>; getToken?: { code: string; codeVerifier?: string; redirect_uri?: string }; redirectUri?: string } = {};
    const factory = (o: { redirectUri: string }): OAuthClientLike => {
      calls.redirectUri = o.redirectUri;
      return {
        generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
        generateAuthUrl: (opts) => {
          calls.authUrl = opts;
          const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          u.searchParams.set('state', String(opts.state));
          u.searchParams.set('redirect_uri', o.redirectUri);
          return u.toString();
        },
        getToken: async (opts) => {
          calls.getToken = opts;
          return { tokens };
        },
      };
    };
    return { calls, factory };
  }

  /** Plays the browser: follow the consent URL straight to the loopback callback. */
  const browser = (mutate: (cb: URL, state: string) => void) => (url: string) => {
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    mutate(cb, u.searchParams.get('state')!);
    void fetch(cb).catch(() => undefined);
  };

  it('completes the flow and prints env lines', async () => {
    const { calls, factory } = fakeOAuth();
    const r = await cli(['auth', 'login'], {
      createOAuthClient: factory,
      openUrl: browser((cb, state) => {
        cb.searchParams.set('code', 'the-code');
        cb.searchParams.set('state', state);
      }),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('DRIVEBUCKET_REFRESH_TOKEN=NEW_REFRESH');
    expect(r.err).not.toContain('NEW_REFRESH');
    expect(calls.authUrl).toMatchObject({ access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', code_challenge: 'challenge', scope: ['https://www.googleapis.com/auth/drive.file'] });
    expect(calls.getToken).toEqual({ code: 'the-code', codeVerifier: 'verifier', redirect_uri: calls.redirectUri });
    expect(calls.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('rejects a state mismatch and Google errors', async () => {
    const { factory } = fakeOAuth();
    const mismatch = await cli(['auth', 'login'], {
      createOAuthClient: factory,
      openUrl: browser((cb) => {
        cb.searchParams.set('code', 'c');
        cb.searchParams.set('state', 'forged');
      }),
    });
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('state mismatch');
    const denied = await cli(['auth', 'login'], { createOAuthClient: factory, openUrl: browser((cb) => cb.searchParams.set('error', 'access_denied')) });
    expect(denied.err).toContain('access_denied');
  });

  it('explains a missing refresh token and requires client credentials', async () => {
    const { factory } = fakeOAuth({ scope: 'x' });
    const r = await cli(['auth', 'login'], {
      createOAuthClient: factory,
      openUrl: browser((cb, state) => {
        cb.searchParams.set('code', 'c');
        cb.searchParams.set('state', state);
      }),
    });
    expect(r.err).toContain('did not return a refresh token');
    expect((await cli(['auth', 'login'], { env: {} })).code).toBe(2);
  });

  it('times out', async () => {
    const { factory } = fakeOAuth();
    await expect(oauthLogin({ clientId: 'a', clientSecret: 'b', log: () => {}, createClient: factory, timeoutMs: 50 })).rejects.toThrow(/Timed out/);
  });
});

describe('md5 sanity', () => {
  it('cp preserves bytes', async () => {
    await adapter.createBucket('bin');
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
    await writeFile(join(dir, 'blob.bin'), data);
    await cli(['cp', 'blob.bin', 'db://bin/blob.bin']);
    expect((await adapter.head('bin', 'blob.bin')).etag).toBe(createHash('md5').update(data).digest('hex'));
  });
});
