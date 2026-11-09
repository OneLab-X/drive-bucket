import { ConfigError, driveOptionsFromEnv, type DriveAdapterOptions } from '@drivebucket/core';
import type { BucketPolicy, CorsOptions } from './app.js';
import type { S3Credential } from './s3/sigv4.js';

/**
 * Env-driven config for the Docker image / CLI. Library users can skip this and call
 * `createServer()` with their own adapter.
 *
 * Auth (pick one):
 *   DRIVEBUCKET_CLIENT_ID + DRIVEBUCKET_CLIENT_SECRET + DRIVEBUCKET_REFRESH_TOKEN   (OAuth user)
 *   DRIVEBUCKET_SA_KEY_FILE | DRIVEBUCKET_SA_KEY_JSON  [+ DRIVEBUCKET_SA_SUBJECT]   (service account)
 * Storage:   DRIVEBUCKET_SHARED_DRIVE_ID, DRIVEBUCKET_ROOT_FOLDER_ID, DRIVEBUCKET_SCOPE=drive.file|drive
 * Tuning:    DRIVEBUCKET_CONCURRENCY (8), DRIVEBUCKET_PERMANENT_DELETE (false)
 * Proxy:     DRIVEBUCKET_PUBLIC_BUCKETS=photos,avatars, DRIVEBUCKET_CACHE_CONTROL
 * Resize:    DRIVEBUCKET_RESIZE=on|off, DRIVEBUCKET_RESIZE_WIDTHS=320,640,1280,
 *            DRIVEBUCKET_RESIZE_CACHE_DIR, DRIVEBUCKET_RESIZE_CACHE_MAX_MB (1024)
 * S3 API:    DRIVEBUCKET_S3_ACCESS_KEY_ID + DRIVEBUCKET_S3_SECRET_ACCESS_KEY, or
 *            DRIVEBUCKET_S3_CREDENTIALS='[{"accessKeyId":"..","secretAccessKey":"..","buckets":["photos"],"readOnly":false}]'
 *            DRIVEBUCKET_S3_REGION (auto), DRIVEBUCKET_MULTIPART_DIR, DRIVEBUCKET_MAX_OBJECT_MB
 * CORS:      DRIVEBUCKET_CORS_ORIGINS=https://app.example.com,https://admin.example.com | *
 * Shared:    DRIVEBUCKET_REDIS_URL (key index + resize cache when no cache dir)
 * Server:    PORT (8080), HOST (0.0.0.0), DRIVEBUCKET_TRUST_PROXY, DRIVEBUCKET_LOG_LEVEL
 */
export interface EnvConfig {
  adapter: Omit<DriveAdapterOptions, 'index'>;
  buckets: Record<string, BucketPolicy>;
  defaultCacheControl?: string;
  resize: false | { allowedWidths?: number[]; cacheDir?: string; cacheMaxBytes: number };
  redisUrl?: string;
  s3?: { credentials: S3Credential[]; region: string; multipartDir?: string };
  cors?: CorsOptions;
  maxObjectBytes?: number;
  port: number;
  host: string;
  trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(env: Env, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function s3CredentialsFromEnv(env: Env): S3Credential[] {
  const out: S3Credential[] = [];
  if (env.DRIVEBUCKET_S3_CREDENTIALS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.DRIVEBUCKET_S3_CREDENTIALS);
    } catch {
      throw new ConfigError('DRIVEBUCKET_S3_CREDENTIALS must be a JSON array of {accessKeyId, secretAccessKey, buckets?, readOnly?}');
    }
    if (!Array.isArray(parsed)) throw new ConfigError('DRIVEBUCKET_S3_CREDENTIALS must be a JSON array');
    for (const [i, c] of parsed.entries()) {
      const cred = c as Partial<S3Credential>;
      if (typeof cred.accessKeyId !== 'string' || typeof cred.secretAccessKey !== 'string') {
        throw new ConfigError(`DRIVEBUCKET_S3_CREDENTIALS[${i}] needs accessKeyId and secretAccessKey strings`);
      }
      if (cred.buckets !== undefined && cred.buckets !== '*' && !(Array.isArray(cred.buckets) && cred.buckets.every((b) => typeof b === 'string'))) {
        throw new ConfigError(`DRIVEBUCKET_S3_CREDENTIALS[${i}].buckets must be "*" or an array of names`);
      }
      out.push({
        accessKeyId: cred.accessKeyId,
        secretAccessKey: cred.secretAccessKey,
        ...(cred.buckets !== undefined ? { buckets: cred.buckets } : {}),
        ...(cred.readOnly ? { readOnly: true } : {}),
      });
    }
  }
  const id = env.DRIVEBUCKET_S3_ACCESS_KEY_ID;
  const secret = env.DRIVEBUCKET_S3_SECRET_ACCESS_KEY;
  if (id || secret) {
    if (!id || !secret) throw new ConfigError('Set both DRIVEBUCKET_S3_ACCESS_KEY_ID and DRIVEBUCKET_S3_SECRET_ACCESS_KEY');
    out.push({ accessKeyId: id, secretAccessKey: secret });
  }
  const ids = new Set<string>();
  for (const c of out) {
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(c.accessKeyId)) throw new ConfigError(`S3 access key id ${JSON.stringify(c.accessKeyId)} must be 3-128 chars of [A-Za-z0-9_-]`);
    // Do not echo the secret.
    if (c.secretAccessKey.length < 16) throw new ConfigError(`S3 secret for ${c.accessKeyId} is too short (min 16 chars; use 40 random chars)`);
    if (ids.has(c.accessKeyId)) throw new ConfigError(`Duplicate S3 access key id ${c.accessKeyId}`);
    ids.add(c.accessKeyId);
  }
  return out;
}

export function loadConfigFromEnv(env: Env = process.env): EnvConfig {
  const adapter = driveOptionsFromEnv(env);
  const buckets: Record<string, BucketPolicy> = {};
  for (const b of list(env.DRIVEBUCKET_PUBLIC_BUCKETS)) buckets[b] = { public: true };

  const widths = list(env.DRIVEBUCKET_RESIZE_WIDTHS).map(Number);
  if (widths.some((w) => !Number.isInteger(w) || w <= 0)) throw new ConfigError('DRIVEBUCKET_RESIZE_WIDTHS must be comma-separated positive integers');
  const resize: EnvConfig['resize'] = bool(env.DRIVEBUCKET_RESIZE, true)
    ? {
        cacheMaxBytes: int(env, 'DRIVEBUCKET_RESIZE_CACHE_MAX_MB', 1024) * 1024 * 1024,
        ...(widths.length ? { allowedWidths: widths } : {}),
        ...(env.DRIVEBUCKET_RESIZE_CACHE_DIR ? { cacheDir: env.DRIVEBUCKET_RESIZE_CACHE_DIR } : {}),
      }
    : false;

  const credentials = s3CredentialsFromEnv(env);
  const corsOrigins = env.DRIVEBUCKET_CORS_ORIGINS?.trim();
  const maxMb = env.DRIVEBUCKET_MAX_OBJECT_MB ? int(env, 'DRIVEBUCKET_MAX_OBJECT_MB', 0) : undefined;

  return {
    adapter,
    buckets,
    ...(credentials.length
      ? {
          s3: {
            credentials,
            region: env.DRIVEBUCKET_S3_REGION ?? 'auto',
            ...(env.DRIVEBUCKET_MULTIPART_DIR ? { multipartDir: env.DRIVEBUCKET_MULTIPART_DIR } : {}),
          },
        }
      : {}),
    ...(corsOrigins ? { cors: { origins: corsOrigins === '*' ? ('*' as const) : list(corsOrigins) } } : {}),
    ...(maxMb !== undefined ? { maxObjectBytes: maxMb * 1024 * 1024 } : {}),
    ...(env.DRIVEBUCKET_CACHE_CONTROL ? { defaultCacheControl: env.DRIVEBUCKET_CACHE_CONTROL } : {}),
    resize,
    ...(env.DRIVEBUCKET_REDIS_URL ? { redisUrl: env.DRIVEBUCKET_REDIS_URL } : {}),
    port: int(env, 'PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    trustProxy: bool(env.DRIVEBUCKET_TRUST_PROXY, false),
  };
}
