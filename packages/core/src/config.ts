import { readFileSync } from 'node:fs';
import type { AuthConfig, ScopeName } from './auth.js';
import type { DriveAdapterOptions } from './drive-adapter.js';
import { ConfigError } from './errors.js';

export type Env = Record<string, string | undefined>;

export function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

export function int(env: Env, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

export function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function authFromEnv(env: Env): AuthConfig {
  const oauthVars = ['DRIVEBUCKET_CLIENT_ID', 'DRIVEBUCKET_CLIENT_SECRET', 'DRIVEBUCKET_REFRESH_TOKEN'];
  const hasOauth = oauthVars.some((k) => env[k]);
  const hasSa = Boolean(env.DRIVEBUCKET_SA_KEY_FILE || env.DRIVEBUCKET_SA_KEY_JSON);
  if (hasOauth && hasSa) throw new ConfigError('Set either OAuth (DRIVEBUCKET_CLIENT_ID/...) or service account (DRIVEBUCKET_SA_KEY_*) variables, not both');
  if (hasOauth) {
    const missing = oauthVars.filter((k) => !env[k]);
    if (missing.length) throw new ConfigError(`Missing ${missing.join(', ')}`);
    return {
      type: 'oauthRefreshToken',
      clientId: env.DRIVEBUCKET_CLIENT_ID!,
      clientSecret: env.DRIVEBUCKET_CLIENT_SECRET!,
      refreshToken: env.DRIVEBUCKET_REFRESH_TOKEN!,
    };
  }
  if (hasSa) {
    let credentials: { client_email: string; private_key: string } | undefined;
    if (env.DRIVEBUCKET_SA_KEY_JSON) {
      try {
        const parsed = JSON.parse(env.DRIVEBUCKET_SA_KEY_JSON) as { client_email?: string; private_key?: string };
        if (!parsed.client_email || !parsed.private_key) throw new Error('missing fields');
        credentials = { client_email: parsed.client_email, private_key: parsed.private_key };
      } catch {
        // Never echo the value: it is a private key.
        throw new ConfigError('DRIVEBUCKET_SA_KEY_JSON is not a valid service account key JSON');
      }
    } else {
      try {
        readFileSync(env.DRIVEBUCKET_SA_KEY_FILE!);
      } catch {
        throw new ConfigError(`DRIVEBUCKET_SA_KEY_FILE ${env.DRIVEBUCKET_SA_KEY_FILE} is not readable`);
      }
    }
    return {
      type: 'serviceAccount',
      ...(credentials ? { credentials } : { keyFile: env.DRIVEBUCKET_SA_KEY_FILE! }),
      ...(env.DRIVEBUCKET_SA_SUBJECT ? { subject: env.DRIVEBUCKET_SA_SUBJECT } : {}),
    };
  }
  throw new ConfigError(
    'No Google credentials. Set DRIVEBUCKET_CLIENT_ID, DRIVEBUCKET_CLIENT_SECRET and DRIVEBUCKET_REFRESH_TOKEN, ' +
      'or DRIVEBUCKET_SA_KEY_FILE / DRIVEBUCKET_SA_KEY_JSON (+ DRIVEBUCKET_SHARED_DRIVE_ID or DRIVEBUCKET_SA_SUBJECT).',
  );
}

/**
 * DriveAdapter options from environment variables (shared by the server, CLI and Next.js helper).
 *
 * Auth (pick one):
 *   DRIVEBUCKET_CLIENT_ID + DRIVEBUCKET_CLIENT_SECRET + DRIVEBUCKET_REFRESH_TOKEN   (OAuth user)
 *   DRIVEBUCKET_SA_KEY_FILE | DRIVEBUCKET_SA_KEY_JSON  [+ DRIVEBUCKET_SA_SUBJECT]   (service account)
 * Storage: DRIVEBUCKET_SHARED_DRIVE_ID, DRIVEBUCKET_ROOT_FOLDER_ID, DRIVEBUCKET_SCOPE=drive.file|drive
 * Tuning:  DRIVEBUCKET_CONCURRENCY (8), DRIVEBUCKET_PERMANENT_DELETE (false), DRIVEBUCKET_MAX_OBJECT_MB
 */
export function driveOptionsFromEnv(env: Env = process.env): Omit<DriveAdapterOptions, 'index'> {
  const scope = (env.DRIVEBUCKET_SCOPE ?? 'drive.file') as ScopeName;
  if (scope !== 'drive.file' && scope !== 'drive') throw new ConfigError('DRIVEBUCKET_SCOPE must be drive.file or drive');
  const maxMb = env.DRIVEBUCKET_MAX_OBJECT_MB ? int(env, 'DRIVEBUCKET_MAX_OBJECT_MB', 0) : undefined;
  return {
    auth: authFromEnv(env),
    scope,
    concurrency: int(env, 'DRIVEBUCKET_CONCURRENCY', 8),
    permanentDelete: bool(env.DRIVEBUCKET_PERMANENT_DELETE, false),
    ...(env.DRIVEBUCKET_SHARED_DRIVE_ID ? { sharedDriveId: env.DRIVEBUCKET_SHARED_DRIVE_ID } : {}),
    ...(env.DRIVEBUCKET_ROOT_FOLDER_ID ? { rootFolderId: env.DRIVEBUCKET_ROOT_FOLDER_ID } : {}),
    ...(maxMb !== undefined ? { maxObjectBytes: maxMb * 1024 * 1024 } : {}),
  };
}
