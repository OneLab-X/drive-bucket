import { createHash, randomUUID } from 'node:crypto';
import { DriveAdapter, type DriveAdapterOptions, isDriveBucketError } from '@drivebucket/core';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  adapter: DriveAdapter;
  options: Omit<DriveAdapterOptions, 'index'>;
  /** Scopes actually granted to the OAuth token (undefined = can't tell, e.g. service account). */
  grantedScopes?: () => Promise<string[] | undefined>;
  writeTestBucket?: string;
  nodeVersion?: string;
}

const GiB = 1024 ** 3;

function explain(err: unknown): string {
  const msg = isDriveBucketError(err) ? `${err.code}: ${err.message}` : (err as Error)?.message ?? String(err);
  if (/invalid_grant/i.test(msg)) {
    return `${msg}. The refresh token was revoked or expired. If your OAuth consent screen is in "Testing" mode, Google expires refresh tokens after 7 days: publish the app (or use a service account) and run "drivebucket auth login" again.`;
  }
  if (/invalid_client|unauthorized_client/i.test(msg)) return `${msg}. Check DRIVEBUCKET_CLIENT_ID / DRIVEBUCKET_CLIENT_SECRET.`;
  if (/has not been used|is disabled|accessNotConfigured/i.test(msg)) return `${msg}. Enable the Google Drive API for this Cloud project.`;
  return msg;
}

/** Run read-only health checks (plus an optional write/read/delete round trip). */
export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  const major = Number((d.nodeVersion ?? process.versions.node).split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `Node ${d.nodeVersion ?? process.versions.node}${major >= 20 ? '' : ' (need >= 20)'}`);

  const auth = d.options.auth;
  const isSA = auth?.type === 'serviceAccount';
  add('auth type', 'ok', isSA ? `service account${auth.subject ? ` acting as ${auth.subject}` : ''}` : 'OAuth refresh token');

  // Credentials + quota
  let credsOk = false;
  if (!d.adapter.api.getAbout) {
    add('credentials', 'skip', 'Drive API client cannot report account info');
  } else {
    try {
      const about = await d.adapter.api.getAbout();
      credsOk = true;
      add('credentials', 'ok', `signed in as ${about.user?.emailAddress ?? 'unknown'}`);
      const limit = about.storageQuota?.limit ? Number(about.storageQuota.limit) : undefined;
      const usage = Number(about.storageQuota?.usage ?? 0);
      if (isSA && !auth.subject) {
        add('storage quota', d.options.sharedDriveId ? 'ok' : 'fail', d.options.sharedDriveId ? 'service account: files are stored in the shared drive (its quota applies)' : 'service accounts have no storage of their own; set DRIVEBUCKET_SHARED_DRIVE_ID');
      } else if (limit === undefined || limit === 0) {
        add('storage quota', 'ok', `${(usage / GiB).toFixed(2)} GiB used, no per-user limit (pooled storage)`);
      } else {
        const pct = (usage / limit) * 100;
        add('storage quota', pct >= 99 ? 'fail' : pct >= 90 ? 'warn' : 'ok', `${(usage / GiB).toFixed(2)} / ${(limit / GiB).toFixed(2)} GiB (${pct.toFixed(1)}%)`);
      }
    } catch (err) {
      add('credentials', 'fail', explain(err));
    }
  }

  // Scopes
  if (d.grantedScopes && credsOk) {
    try {
      const scopes = await d.grantedScopes();
      if (scopes === undefined) add('scopes', 'skip', 'not reported for this credential type');
      else {
        const want = d.options.scope ?? 'drive.file';
        const hasFull = scopes.includes('https://www.googleapis.com/auth/drive');
        const hasFile = scopes.includes('https://www.googleapis.com/auth/drive.file');
        if (want === 'drive' && !hasFull) add('scopes', 'fail', 'DRIVEBUCKET_SCOPE=drive but the token only has drive.file; run "drivebucket auth login --scope drive"');
        else if (!hasFull && !hasFile) add('scopes', 'fail', `token has no Drive scope (${scopes.join(' ') || 'none'})`);
        else add('scopes', 'ok', hasFull ? 'drive (full access)' : 'drive.file (files created by this app only)');
      }
    } catch (err) {
      add('scopes', 'warn', `could not read token scopes: ${explain(err)}`);
    }
  }

  // Shared drive
  if (d.options.sharedDriveId) {
    try {
      const drive = await d.adapter.api.getDrive(d.options.sharedDriveId);
      add('shared drive', 'ok', `${drive.name ?? drive.id} (${drive.id})`);
    } catch (err) {
      add('shared drive', 'fail', `${d.options.sharedDriveId} not accessible: add ${isSA ? 'the service account email' : 'this account'} as a Content manager. ${explain(err)}`);
    }
  }

  // Root folder + buckets
  let rootOk = false;
  try {
    const root = await d.adapter.init();
    rootOk = true;
    add('root folder', 'ok', root);
  } catch (err) {
    add('root folder', 'fail', explain(err));
  }
  if (rootOk) {
    try {
      const buckets = await d.adapter.listBuckets();
      add('buckets', 'ok', buckets.length ? buckets.map((b) => b.name).join(', ') : 'none yet (drivebucket buckets create <name>)');
    } catch (err) {
      add('buckets', 'fail', explain(err));
    }
  }

  // Optional round trip
  if (d.writeTestBucket && rootOk) {
    const key = `.drivebucket-doctor/${randomUUID()}`;
    const body = Buffer.from(`drivebucket doctor ${new Date().toISOString()}`);
    try {
      const put = await d.adapter.put(d.writeTestBucket, key, body, { contentType: 'text/plain' });
      const got = await d.adapter.get(d.writeTestBucket, key);
      const chunks: Buffer[] = [];
      for await (const c of got.stream) chunks.push(Buffer.from(c as Uint8Array));
      const ok = Buffer.concat(chunks).equals(body) && put.etag === createHash('md5').update(body).digest('hex');
      await d.adapter.delete(d.writeTestBucket, key, { permanent: true });
      add('write test', ok ? 'ok' : 'fail', ok ? `put/get/delete in ${d.writeTestBucket}` : 'content mismatch after round trip');
    } catch (err) {
      add('write test', 'fail', explain(err));
    }
  }
  return checks;
}
