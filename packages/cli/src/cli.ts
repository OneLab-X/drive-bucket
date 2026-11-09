import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import {
  createAuthClient,
  DriveAdapter,
  type DriveAdapterOptions,
  driveOptionsFromEnv,
  type Env,
  isDriveBucketError,
  type ScopeName,
} from '@drivebucket/core';
import { runDoctor, type Check } from './doctor.js';
import { oauthLogin, type OAuthClientLike } from './login.js';

export const VERSION = '0.0.0';

export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: Env;
  cwd: string;
  /** Build the adapter (tests inject one backed by FakeDrive). */
  createAdapter?: (options: Omit<DriveAdapterOptions, 'index'>) => DriveAdapter;
  /** Scopes granted to the current credentials (tests). */
  grantedScopes?: () => Promise<string[] | undefined>;
  openUrl?: (url: string) => void;
  createOAuthClient?: (o: { clientId: string; clientSecret: string; redirectUri: string }) => OAuthClientLike;
  isTTY?: boolean;
}

class UsageError extends Error {}

const HELP = `drivebucket ${VERSION} — Google Drive as an object store

Usage: drivebucket [--env-file .env] <command> [options]

Commands:
  auth login [--client-id ID --client-secret S] [--scope drive.file|drive] [--port N] [--no-open]
                         Browser sign-in; prints DRIVEBUCKET_REFRESH_TOKEN
  doctor [--write-test BUCKET]
                         Check credentials, scopes, quota, shared drive, root folder
  buckets ls             List buckets
  buckets create NAME    Create a bucket
  buckets rm NAME        Delete an empty bucket
  ls db://BUCKET[/PREFIX] [-r] [--json]
                         List objects (one level, or all with -r)
  cp SRC DST [-r] [--content-type T] [--cache-control C]
                         Copy between local paths, "-" (stdin/stdout) and db://BUCKET/KEY
  rm db://BUCKET/KEY [-r] [--permanent]
                         Delete an object, or everything under a prefix with -r

Credentials come from the environment (see .env.example): DRIVEBUCKET_CLIENT_ID,
DRIVEBUCKET_CLIENT_SECRET, DRIVEBUCKET_REFRESH_TOKEN, or DRIVEBUCKET_SA_KEY_FILE (+ DRIVEBUCKET_SHARED_DRIVE_ID).
`;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};

export function guessType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function parseEnvFile(text: string): Env {
  const out: Env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
      if (m[2]!.startsWith('"')) v = v.replace(/\\n/g, '\n');
    } else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

export interface DbUrl {
  bucket: string;
  key: string;
}

export function parseDbUrl(s: string): DbUrl | undefined {
  if (!s.startsWith('db://')) return undefined;
  const rest = s.slice('db://'.length);
  const i = rest.indexOf('/');
  const bucket = i < 0 ? rest : rest.slice(0, i);
  if (!bucket) throw new UsageError(`Missing bucket in ${s}`);
  return { bucket, key: i < 0 ? '' : rest.slice(i + 1) };
}

function humanSize(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function defaultOpenUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Printing the URL is enough.
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`${s}\n`);

  // Global flags before the command.
  let env = io.env;
  const args = [...argv];
  while (args[0]?.startsWith('-')) {
    const flag = args.shift()!;
    if (flag === '-h' || flag === '--help') {
      out(HELP);
      return 0;
    }
    if (flag === '-v' || flag === '--version') {
      out(VERSION);
      return 0;
    }
    if (flag === '--env-file') {
      const path = args.shift();
      if (!path) {
        err('--env-file needs a path');
        return 2;
      }
      try {
        env = { ...parseEnvFile(await readFile(join(io.cwd, path), 'utf8')), ...io.env };
      } catch {
        err(`Cannot read env file ${path}`);
        return 2;
      }
      continue;
    }
    err(`Unknown option ${flag}`);
    return 2;
  }
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help') {
    out(HELP);
    return cmd ? 0 : 2;
  }

  let adapterCache: { adapter: DriveAdapter; options: Omit<DriveAdapterOptions, 'index'> } | undefined;
  const getAdapter = () => {
    if (!adapterCache) {
      const options = driveOptionsFromEnv(env);
      adapterCache = { options, adapter: io.createAdapter ? io.createAdapter(options) : new DriveAdapter(options) };
    }
    return adapterCache;
  };

  try {
    switch (cmd) {
      case 'auth':
        return await authCmd(rest);
      case 'doctor':
        return await doctorCmd(rest);
      case 'buckets':
        return await bucketsCmd(rest);
      case 'ls':
        return await lsCmd(rest);
      case 'cp':
        return await cpCmd(rest);
      case 'rm':
        return await rmCmd(rest);
      default:
        throw new UsageError(`Unknown command "${cmd}". Run drivebucket --help.`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      return 2;
    }
    if (isDriveBucketError(e)) err(`${e.code}: ${e.message}`);
    else err((e as Error)?.message ?? String(e));
    return 1;
  }

  // ------------------------------------------------------------------ commands

  async function authCmd(a: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: a,
      allowPositionals: true,
      options: {
        'client-id': { type: 'string' },
        'client-secret': { type: 'string' },
        scope: { type: 'string', default: 'drive.file' },
        port: { type: 'string', default: '0' },
        'no-open': { type: 'boolean', default: false },
      },
    });
    if (positionals[0] !== 'login') throw new UsageError('Usage: drivebucket auth login [--client-id ID --client-secret SECRET] [--scope drive.file|drive]');
    const clientId = values['client-id'] ?? env.DRIVEBUCKET_CLIENT_ID;
    const clientSecret = values['client-secret'] ?? env.DRIVEBUCKET_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new UsageError('Need an OAuth client of type "Desktop app": pass --client-id/--client-secret or set DRIVEBUCKET_CLIENT_ID/DRIVEBUCKET_CLIENT_SECRET');
    }
    const scope = values.scope as ScopeName;
    if (scope !== 'drive.file' && scope !== 'drive') throw new UsageError('--scope must be drive.file or drive');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be 0-65535');
    const res = await oauthLogin({
      clientId,
      clientSecret,
      scope,
      port,
      log: err,
      ...(values['no-open'] ? {} : { openUrl: io.openUrl ?? defaultOpenUrl }),
      ...(io.createOAuthClient ? { createClient: io.createOAuthClient } : {}),
    });
    err('');
    err(`Authorized (${res.scopes.join(' ') || scope}). Add this to your environment — it is a secret:`);
    out(`DRIVEBUCKET_CLIENT_ID=${clientId}`);
    out(`DRIVEBUCKET_CLIENT_SECRET=${clientSecret}`);
    out(`DRIVEBUCKET_REFRESH_TOKEN=${res.refreshToken}`);
    if (scope === 'drive') out('DRIVEBUCKET_SCOPE=drive');
    return 0;
  }

  async function doctorCmd(a: string[]): Promise<number> {
    const { values } = parseArgs({ args: a, options: { 'write-test': { type: 'string' }, json: { type: 'boolean', default: false } } });
    let checks: Check[];
    try {
      const { adapter, options } = getAdapter();
      const grantedScopes =
        io.grantedScopes ??
        (options.auth?.type === 'oauthRefreshToken'
          ? async () => {
              const client = createAuthClient(options.auth!, options.scope) as unknown as {
                getAccessToken(): Promise<{ token?: string | null }>;
                getTokenInfo(t: string): Promise<{ scopes: string[] }>;
              };
              const { token } = await client.getAccessToken();
              return token ? (await client.getTokenInfo(token)).scopes : undefined;
            }
          : async () => undefined);
      checks = await runDoctor({ adapter, options, grantedScopes, ...(values['write-test'] ? { writeTestBucket: values['write-test'] } : {}) });
    } catch (e) {
      checks = [{ name: 'config', status: 'fail', detail: isDriveBucketError(e) ? e.message : String((e as Error).message ?? e) }];
    }
    if (values.json) out(JSON.stringify(checks, null, 2));
    else {
      const mark = { ok: '✓', warn: '!', fail: '✗', skip: '-' } as const;
      const w = Math.max(...checks.map((c) => c.name.length));
      for (const c of checks) out(`${mark[c.status]} ${c.name.padEnd(w)}  ${c.detail}`);
    }
    return checks.some((c) => c.status === 'fail') ? 1 : 0;
  }

  async function bucketsCmd(a: string[]): Promise<number> {
    const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
    const [sub, name] = positionals;
    const { adapter } = getAdapter();
    if (sub === 'ls' || sub === undefined) {
      const buckets = await adapter.listBuckets();
      if (values.json) out(JSON.stringify(buckets.map((b) => ({ name: b.name, createdAt: b.createdAt.toISOString() }))));
      else for (const b of buckets) out(`${fmtDate(b.createdAt)}  ${b.name}`);
      return 0;
    }
    if (!name) throw new UsageError(`Usage: drivebucket buckets ${sub} NAME`);
    if (sub === 'create') {
      await adapter.createBucket(name);
      err(`created bucket ${name}`);
      return 0;
    }
    if (sub === 'rm') {
      await adapter.deleteBucket(name);
      err(`deleted bucket ${name}`);
      return 0;
    }
    throw new UsageError(`Unknown buckets subcommand "${sub}"`);
  }

  async function lsCmd(a: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: a,
      allowPositionals: true,
      options: { recursive: { type: 'boolean', short: 'r', default: false }, json: { type: 'boolean', default: false } },
    });
    if (!positionals[0]) return bucketsCmd(values.json ? ['ls', '--json'] : ['ls']);
    const target = parseDbUrl(positionals[0]);
    if (!target) throw new UsageError('ls takes db://BUCKET[/PREFIX]');
    const { adapter } = getAdapter();
    let token: string | undefined;
    const rows: Array<{ key: string; size?: number; lastModified?: string; etag?: string; prefix?: boolean }> = [];
    do {
      const res = await adapter.list(target.bucket, {
        prefix: target.key,
        ...(values.recursive ? {} : { delimiter: '/' }),
        ...(token ? { continuationToken: token } : {}),
      });
      for (const p of res.commonPrefixes) rows.push({ key: p, prefix: true });
      for (const o of res.objects) rows.push({ key: o.key, size: o.size, lastModified: o.lastModified.toISOString(), etag: o.etag });
      token = res.nextContinuationToken;
    } while (token);
    if (values.json) out(JSON.stringify(rows));
    else {
      for (const r of rows) {
        if (r.prefix) out(`${''.padEnd(16)}  ${'PRE'.padStart(10)}  ${r.key}`);
        else out(`${fmtDate(new Date(r.lastModified!))}  ${humanSize(r.size!).padStart(10)}  ${r.key}`);
      }
    }
    return 0;
  }

  async function cpCmd(a: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: a,
      allowPositionals: true,
      options: {
        recursive: { type: 'boolean', short: 'r', default: false },
        'content-type': { type: 'string' },
        'cache-control': { type: 'string' },
      },
    });
    if (positionals.length !== 2) throw new UsageError('Usage: drivebucket cp SRC DST');
    const [srcArg, dstArg] = positionals as [string, string];
    const src = parseDbUrl(srcArg);
    const dst = parseDbUrl(dstArg);
    const { adapter } = getAdapter();
    const putOpts = (path: string) => ({
      contentType: values['content-type'] ?? guessType(path),
      ...(values['cache-control'] ? { cacheControl: values['cache-control'] } : {}),
    });
    const dstKeyFor = (d: { key: string }, name: string) => (d.key === '' || d.key.endsWith('/') ? `${d.key}${name}` : d.key);

    // remote -> remote
    if (src && dst) {
      if (!src.key) throw new UsageError('Source needs a key');
      const res = await adapter.copy(src.bucket, src.key, dst.bucket, dstKeyFor(dst, basename(src.key)));
      err(`copied db://${src.bucket}/${src.key} -> db://${dst.bucket}/${res.key}`);
      return 0;
    }
    // local/stdin -> remote
    if (dst) {
      if (srcArg === '-') {
        if (!dst.key || dst.key.endsWith('/')) throw new UsageError('Uploading stdin needs a full destination key');
        const res = await adapter.put(dst.bucket, dst.key, io.stdin, putOpts(dst.key));
        err(`uploaded stdin -> db://${dst.bucket}/${res.key} (${humanSize(res.size)})`);
        return 0;
      }
      const local = join(io.cwd, srcArg);
      const st = await stat(local).catch(() => undefined);
      if (!st) throw new UsageError(`No such file: ${srcArg}`);
      if (st.isDirectory()) {
        if (!values.recursive) throw new UsageError(`${srcArg} is a directory (use -r)`);
        const prefix = dst.key === '' || dst.key.endsWith('/') ? dst.key : `${dst.key}/`;
        let n = 0;
        for await (const file of walk(local)) {
          const key = prefix + relative(local, file).split(sep).join('/');
          await adapter.put(dst.bucket, key, createReadStream(file), { ...putOpts(file), contentLength: (await stat(file)).size });
          out(`upload: ${relative(io.cwd, file)} -> db://${dst.bucket}/${key}`);
          n++;
        }
        err(`${n} file(s) uploaded`);
        return 0;
      }
      const key = dstKeyFor(dst, basename(local));
      const res = await adapter.put(dst.bucket, key, createReadStream(local), { ...putOpts(local), contentLength: st.size });
      err(`uploaded ${srcArg} -> db://${dst.bucket}/${res.key} (${humanSize(res.size)})`);
      return 0;
    }
    // remote -> local/stdout
    if (src) {
      if (!src.key) throw new UsageError('Source needs a key');
      if (values.recursive) {
        const prefix = src.key.endsWith('/') ? src.key : `${src.key}/`;
        let token: string | undefined;
        let n = 0;
        do {
          const res = await adapter.list(src.bucket, { prefix, ...(token ? { continuationToken: token } : {}) });
          for (const o of res.objects) {
            const target = join(io.cwd, dstArg, ...o.key.slice(prefix.length).split('/'));
            if (!target.startsWith(join(io.cwd, dstArg))) throw new UsageError(`Refusing to write outside ${dstArg}: ${o.key}`);
            await mkdir(join(target, '..'), { recursive: true });
            const got = await adapter.get(src.bucket, o.key);
            await pipeline(got.stream, createWriteStream(target));
            out(`download: db://${src.bucket}/${o.key} -> ${relative(io.cwd, target)}`);
            n++;
          }
          token = res.nextContinuationToken;
        } while (token);
        err(`${n} file(s) downloaded`);
        return 0;
      }
      const got = await adapter.get(src.bucket, src.key);
      if (dstArg === '-') {
        await pipeline(got.stream, io.stdout, { end: false });
        return 0;
      }
      let target = join(io.cwd, dstArg);
      const st = await stat(target).catch(() => undefined);
      if (st?.isDirectory() || dstArg.endsWith('/')) target = join(target, basename(src.key));
      await pipeline(got.stream, createWriteStream(target));
      err(`downloaded db://${src.bucket}/${src.key} -> ${relative(io.cwd, target) || target} (${humanSize(got.size)})`);
      return 0;
    }
    throw new UsageError('One side of cp must be db://BUCKET/KEY');
  }

  async function rmCmd(a: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: a,
      allowPositionals: true,
      options: { recursive: { type: 'boolean', short: 'r', default: false }, permanent: { type: 'boolean', default: false } },
    });
    const target = positionals[0] ? parseDbUrl(positionals[0]) : undefined;
    if (!target || positionals.length !== 1) throw new UsageError('Usage: drivebucket rm db://BUCKET/KEY [-r] [--permanent]');
    const { adapter } = getAdapter();
    const opts = values.permanent ? { permanent: true } : {};
    if (!values.recursive) {
      if (!target.key) throw new UsageError('rm needs a key (or -r for a prefix)');
      const res = await adapter.delete(target.bucket, target.key, opts);
      if (!res.deleted) {
        err(`not found: db://${target.bucket}/${target.key}`);
        return 1;
      }
      err(`deleted db://${target.bucket}/${target.key}${values.permanent ? '' : ' (moved to Drive trash)'}`);
      return 0;
    }
    if (!target.key && !io.env.DRIVEBUCKET_CONFIRM_RM_ALL) {
      throw new UsageError(`Refusing to delete every object in ${target.bucket}. Set DRIVEBUCKET_CONFIRM_RM_ALL=1 to confirm.`);
    }
    // Collect first: deleting while paginating would shift the listing.
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await adapter.list(target.bucket, { prefix: target.key, ...(token ? { continuationToken: token } : {}) });
      keys.push(...res.objects.map((o) => o.key));
      token = res.nextContinuationToken;
    } while (token);
    await Promise.all(keys.map(async (k) => {
      await adapter.delete(target.bucket, k, opts);
      out(`delete: db://${target.bucket}/${k}`);
    }));
    err(`${keys.length} object(s) deleted${values.permanent ? '' : ' (moved to Drive trash)'}`);
    return 0;
  }
}
