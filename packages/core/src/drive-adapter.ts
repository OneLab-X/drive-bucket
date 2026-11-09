import { createHash } from 'node:crypto';
import { createAuthClient, type AuthClient, type AuthConfig, type ScopeName } from './auth.js';
import { GoogleDriveApi, type ChunkResult, type DriveApi, type DriveFile, type FileMetadataInput } from './drive-api.js';
import {
  BadDigest,
  BucketAlreadyExists,
  ConfigError,
  DriveApiError,
  DriveBucketError,
  InvalidRange,
  NoSuchBucket,
  NoSuchKey,
  PreconditionFailed,
} from './errors.js';
import { MemoryLRUIndex } from './index/memory.js';
import type { KeyIndex } from './index/types.js';
import { escapeQuery, fileNameForKey, keyHash, validateBucketName, validateKey } from './keys.js';
import { createLimiter, type Limiter } from './limit.js';
import { decodeObjectProps, encodeObjectProps, PROP_BUCKET, PROP_HASH, PROP_MARKER, PROP_SPILL } from './metadata.js';
import { withRetry, type RetryOptions } from './retry.js';
import type {
  Body,
  BucketInfo,
  ByteRange,
  CopyOptions,
  DeleteOptions,
  DeleteResult,
  GetOptions,
  GetResult,
  ListOptions,
  ListResult,
  ObjectInfo,
  ObjectSummary,
  ObjectUpload,
  PutOptions,
  PutResult,
  StorageAdapter,
} from './types.js';
import {
  assertChunkSize,
  ChunkReader,
  DEFAULT_CHUNK_SIZE,
  isReadable,
  MULTIPART_MAX,
  toBuffer,
} from './upload.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,appProperties,description,trashed,driveId,parents';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

export interface Logger {
  debug?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
}

export interface DriveRetryEvent {
  op: string;
  attempt: number;
  delayMs: number;
  reason?: string;
}

export interface DriveObserver {
  onCall?(e: DriveCallEvent): void;
  onRetry?(e: DriveRetryEvent): void;
}

export interface DriveCallEvent {
  op: string;
  durationMs: number;
  ok: boolean;
  status?: number;
}

export interface DriveAdapterOptions {
  /** Credentials. Ignored when `api` or `authClient` is given. */
  auth?: AuthConfig;
  /** Pre-built google-auth-library client. */
  authClient?: AuthClient;
  /** Inject a DriveApi implementation (tests, custom transports). */
  api?: DriveApi;
  /** OAuth scope. Default `drive.file`. */
  scope?: ScopeName;
  /** Shared drive to store buckets in. Required for a service account without `subject`. */
  sharedDriveId?: string;
  /**
   * Existing folder whose children are buckets. With the default `drive.file` scope this must
   * be a folder the app created. When omitted, drivebucket creates/finds `rootFolderName`
   * in My Drive (or uses the shared drive root).
   */
  rootFolderId?: string;
  /** Default "drivebucket". */
  rootFolderName?: string;
  /** Key -> file id cache. Default: in-memory LRU. */
  index?: KeyIndex;
  /** Max parallel Drive calls. Default 8. */
  concurrency?: number;
  retry?: RetryOptions;
  /** Delete permanently instead of moving to trash. Default false. */
  permanentDelete?: boolean;
  /** Resumable chunk size. Multiple of 256 KiB. Default 8 MiB. */
  chunkSize?: number;
  /** Reject bodies larger than this. */
  maxObjectBytes?: number;
  logger?: Logger;
  /** Metrics hook, called once per Drive HTTP attempt. */
  onDriveCall?: (e: DriveCallEvent) => void;
}

function etagMatches(actual: string | null | undefined, wanted: string): boolean {
  if (wanted === '*') return actual !== undefined && actual !== null;
  const norm = (s: string) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
  return actual !== undefined && actual !== null && wanted.split(',').some((w) => norm(w) === norm(actual));
}

function compareKeys(a: string, b: string): number {
  // S3 orders keys by UTF-8 bytes; JS string comparison uses UTF-16 code units.
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface ContinuationToken {
  /** Last key or common prefix returned. */
  k: string;
  /** 1 when `k` is a common prefix: skip everything under it. */
  p?: 1;
}

function encodeToken(t: ContinuationToken): string {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

function decodeToken(s: string): ContinuationToken {
  try {
    const t = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as ContinuationToken;
    if (typeof t.k !== 'string') throw new Error('bad token');
    return t;
  } catch {
    throw new DriveBucketError('The continuation token provided is incorrect', { code: 'InvalidArgument', status: 400 });
  }
}

function is404(err: unknown): boolean {
  return err instanceof DriveBucketError ? err.status === 404 : (err as { response?: { status?: number } })?.response?.status === 404;
}

function resolveRange(range: ByteRange, size: number): { start: number; end: number } {
  if ('suffix' in range) {
    if (range.suffix <= 0 || size === 0) throw new InvalidRange();
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }
  if (range.start < 0 || range.start >= size) throw new InvalidRange();
  const end = range.end === undefined ? size - 1 : Math.min(range.end, size - 1);
  if (end < range.start) throw new InvalidRange();
  return { start: range.start, end };
}

/**
 * Google Drive as a multi-bucket object store. Buckets are folders under a root folder;
 * objects are flat files inside the bucket folder, identified by appProperties.
 *
 * Consistency: Drive `files.list` is eventually consistent and there are no atomic
 * conditional writes. `ifMatch`/`ifNoneMatch` are checked best-effort before writing, and
 * same-key writes are serialized only within this process.
 */
export class DriveAdapter {
  readonly api: DriveApi;
  private readonly opts: DriveAdapterOptions;
  private readonly index: KeyIndex;
  private readonly limit: Limiter;
  private readonly chunkSize: number;
  private readonly isServiceAccountWithoutSubject: boolean;
  private rootPromise: Promise<string> | undefined;
  private readonly bucketFolders = new Map<string, string>();
  private readonly keyLocks = new Map<string, Promise<unknown>>();
  private readonly observers = new Set<DriveObserver>();
  private readonly retryOpts: RetryOptions;

  constructor(opts: DriveAdapterOptions) {
    this.opts = opts;
    this.isServiceAccountWithoutSubject = opts.auth?.type === 'serviceAccount' && !opts.auth.subject;
    if (opts.api) {
      this.api = opts.api;
    } else {
      const authClient = opts.authClient ?? (opts.auth ? createAuthClient(opts.auth, opts.scope) : undefined);
      if (!authClient) throw new ConfigError('DriveAdapter needs `auth`, `authClient` or `api`');
      this.api = new GoogleDriveApi({ auth: authClient, ...(opts.sharedDriveId ? { sharedDriveId: opts.sharedDriveId } : {}) });
    }
    if (this.isServiceAccountWithoutSubject && !opts.sharedDriveId && !opts.rootFolderId) {
      throw new ConfigError(
        'Service accounts have no Drive storage quota. Set `sharedDriveId` (and add the service account as a member of that shared drive), ' +
          'or set `auth.subject` to impersonate a Workspace user via domain-wide delegation.',
      );
    }
    this.index = opts.index ?? new MemoryLRUIndex();
    this.limit = createLimiter(opts.concurrency ?? 8);
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    assertChunkSize(this.chunkSize);
    if (opts.onDriveCall) this.observers.add({ onCall: opts.onDriveCall });
    this.retryOpts = { ...opts.retry };
  }

  /** Subscribe to Drive call/retry events (metrics, logging). Returns an unsubscribe function. */
  observe(observer: DriveObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  private emitCall(e: DriveCallEvent): void {
    for (const o of this.observers) o.onCall?.(e);
  }

  private retryFor(op: string): RetryOptions {
    const user = this.opts.retry?.onRetry;
    return {
      ...this.retryOpts,
      onRetry: (info) => {
        user?.(info);
        const e: DriveRetryEvent = { op, attempt: info.attempt, delayMs: info.delayMs, ...(info.reason ? { reason: info.reason } : {}) };
        for (const o of this.observers) o.onRetry?.(e);
      },
    };
  }

  // ---------------------------------------------------------------- plumbing

  /** Run one Drive call under the concurrency limit with retry/backoff. */
  private call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return this.limit(() =>
      withRetry(
        async () => {
          const t0 = performance.now();
          try {
            const out = await fn();
            this.emitCall({ op, durationMs: performance.now() - t0, ok: true });
            return out;
          } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            this.emitCall({ op, durationMs: performance.now() - t0, ok: false, ...(status !== undefined ? { status } : {}) });
            throw err;
          }
        },
        this.retryFor(op),
        op,
      ),
    );
  }

  private async withKeyLock<T>(bucket: string, key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `${bucket}\0${key}`;
    const prev = this.keyLocks.get(lockKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.keyLocks.set(lockKey, tail);
    try {
      return await run;
    } finally {
      if (this.keyLocks.get(lockKey) === tail) this.keyLocks.delete(lockKey);
    }
  }

  private async removeFile(fileId: string, permanent: boolean): Promise<void> {
    if (permanent) await this.call('files.delete', () => this.api.deleteFile(fileId));
    else await this.call('files.update', () => this.api.updateFile(fileId, { trashed: true }, undefined, 'id'));
  }

  // ---------------------------------------------------------------- root + buckets

  /** Resolve (and validate) the root folder. Called lazily; call it at startup to fail fast. */
  init(): Promise<string> {
    if (!this.rootPromise) {
      this.rootPromise = this.resolveRoot().catch((err) => {
        this.rootPromise = undefined;
        throw err;
      });
    }
    return this.rootPromise;
  }

  private async resolveRoot(): Promise<string> {
    const { sharedDriveId, rootFolderId } = this.opts;
    if (sharedDriveId) {
      try {
        await this.call('drives.get', () => this.api.getDrive(sharedDriveId));
      } catch (err) {
        throw new ConfigError(
          `sharedDriveId ${sharedDriveId} is not a shared drive this account can access. ` +
            'Check the id and add the account (or service account email) as a Content manager.',
          { cause: err },
        );
      }
    }
    if (rootFolderId) {
      let folder: DriveFile;
      try {
        folder = await this.call('files.get', () => this.api.getFile(rootFolderId, 'id,mimeType,trashed,driveId'));
      } catch (err) {
        throw new ConfigError(
          `rootFolderId ${rootFolderId} is not accessible. With the drive.file scope the folder must have been created by this app; ` +
            'omit rootFolderId to let drivebucket create one, or use scope "drive".',
          { cause: err },
        );
      }
      if (folder.mimeType !== FOLDER_MIME || folder.trashed) throw new ConfigError(`rootFolderId ${rootFolderId} is not a live folder`);
      if (sharedDriveId && folder.driveId !== sharedDriveId) {
        throw new ConfigError(`rootFolderId ${rootFolderId} is not inside shared drive ${sharedDriveId}`);
      }
      if (this.isServiceAccountWithoutSubject && !folder.driveId) {
        throw new ConfigError(
          'rootFolderId is in My Drive, but service accounts have no storage quota. Use a folder inside a shared drive, or set `auth.subject`.',
        );
      }
      return rootFolderId;
    }
    if (sharedDriveId) return sharedDriveId;

    // My Drive: find or create an app-owned root folder (visible under drive.file).
    const name = this.opts.rootFolderName ?? 'drivebucket';
    const q =
      `'root' in parents and mimeType='${FOLDER_MIME}' and trashed=false and name='${escapeQuery(name)}' ` +
      `and appProperties has { key='${PROP_MARKER}' and value='root' }`;
    const found = await this.call('files.list', () => this.api.listFiles({ q, fields: 'files(id,createdTime)', pageSize: 10, orderBy: 'createdTime' }));
    const existing = found.files[0];
    if (existing) return existing.id;
    const created = await this.call('files.create', () =>
      this.api.createFile({ name, mimeType: FOLDER_MIME, parents: ['root'], appProperties: { [PROP_MARKER]: 'root' } }, undefined, 'id'),
    );
    return created.id;
  }

  private bucketQuery(rootId: string, bucket?: string): string {
    let q =
      `'${escapeQuery(rootId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false ` +
      `and appProperties has { key='${PROP_MARKER}' and value='bucket' }`;
    if (bucket !== undefined) q += ` and appProperties has { key='${PROP_BUCKET}' and value='${escapeQuery(bucket)}' }`;
    return q;
  }

  private async findBucketFolder(bucket: string): Promise<DriveFile | undefined> {
    const rootId = await this.init();
    const res = await this.call('files.list', () =>
      this.api.listFiles({ q: this.bucketQuery(rootId, bucket), fields: 'files(id,createdTime,appProperties)', pageSize: 10, orderBy: 'createdTime' }),
    );
    return res.files[0];
  }

  private async bucketFolder(bucket: string): Promise<string> {
    validateBucketName(bucket);
    const cached = this.bucketFolders.get(bucket);
    if (cached) return cached;
    const folder = await this.findBucketFolder(bucket);
    if (!folder) throw new NoSuchBucket(bucket);
    this.bucketFolders.set(bucket, folder.id);
    return folder.id;
  }

  async createBucket(bucket: string): Promise<BucketInfo> {
    validateBucketName(bucket);
    return this.withKeyLock('', `bucket:${bucket}`, async () => {
      if (await this.findBucketFolder(bucket)) throw new BucketAlreadyExists(bucket);
      const rootId = await this.init();
      const folder = await this.call('files.create', () =>
        this.api.createFile(
          { name: bucket, mimeType: FOLDER_MIME, parents: [rootId], appProperties: { [PROP_MARKER]: 'bucket', [PROP_BUCKET]: bucket } },
          undefined,
          'id,createdTime',
        ),
      );
      this.bucketFolders.set(bucket, folder.id);
      return { name: bucket, folderId: folder.id, createdAt: new Date(folder.createdTime ?? Date.now()) };
    });
  }

  async headBucket(bucket: string): Promise<BucketInfo> {
    validateBucketName(bucket);
    const folder = await this.findBucketFolder(bucket);
    if (!folder) throw new NoSuchBucket(bucket);
    this.bucketFolders.set(bucket, folder.id);
    return { name: bucket, folderId: folder.id, createdAt: new Date(folder.createdTime ?? 0) };
  }

  async listBuckets(): Promise<BucketInfo[]> {
    const rootId = await this.init();
    const out = new Map<string, BucketInfo>();
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const res = await this.call('files.list', () =>
        this.api.listFiles({
          q: this.bucketQuery(rootId),
          fields: 'nextPageToken,files(id,createdTime,appProperties)',
          pageSize: 1000,
          orderBy: 'createdTime',
          ...(token ? { pageToken: token } : {}),
        }),
      );
      for (const f of res.files) {
        const name = f.appProperties?.[PROP_BUCKET];
        if (!name || out.has(name)) continue;
        out.set(name, { name, folderId: f.id, createdAt: new Date(f.createdTime ?? 0) });
        this.bucketFolders.set(name, f.id);
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
    return [...out.values()].sort((a, b) => compareKeys(a.name, b.name));
  }

  /** Delete an empty bucket. */
  async deleteBucket(bucket: string): Promise<void> {
    const folderId = await this.bucketFolder(bucket);
    const res = await this.call('files.list', () =>
      this.api.listFiles({ q: `'${escapeQuery(folderId)}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 }),
    );
    if (res.files.length > 0) {
      throw new DriveBucketError(`Bucket ${bucket} is not empty`, { code: 'BucketNotEmpty', status: 409 });
    }
    await this.removeFile(folderId, this.opts.permanentDelete ?? false);
    this.bucketFolders.delete(bucket);
  }

  // ---------------------------------------------------------------- object lookup

  /**
   * Find the live file for (bucket, key): index first, then a Drive query on `kh`.
   * If several files claim the key (concurrent creates), keep the newest and trash the rest.
   */
  private async findObject(bucket: string, key: string, folderId: string): Promise<DriveFile | undefined> {
    const hash = keyHash(bucket, key);
    const cachedId = await this.index.get(bucket, key);
    if (cachedId) {
      try {
        const f = await this.call('files.get', () => this.api.getFile(cachedId, FILE_FIELDS));
        if (!f.trashed && f.appProperties?.[PROP_HASH] === hash && f.parents?.includes(folderId) !== false) return f;
      } catch (err) {
        if (!is404(err)) throw err;
      }
      await this.index.delete(bucket, key);
    }

    const q =
      `'${escapeQuery(folderId)}' in parents and trashed=false ` +
      `and appProperties has { key='${PROP_HASH}' and value='${hash}' }`;
    const res = await this.call('files.list', () => this.api.listFiles({ q, fields: LIST_FIELDS, pageSize: 100, orderBy: 'modifiedTime desc' }));
    const matches = res.files
      .filter((f) => {
        const d = decodeObjectProps(f.appProperties, f.description);
        return d?.bucket === bucket && d.key === key;
      })
      .sort((a, b) => Date.parse(b.modifiedTime ?? '0') - Date.parse(a.modifiedTime ?? '0'));
    const [newest, ...dupes] = matches;
    if (!newest) return undefined;
    if (dupes.length > 0) {
      this.opts.logger?.warn?.('drivebucket: duplicate files for key, trashing older copies', { bucket, count: dupes.length });
      for (const d of dupes) {
        this.removeFile(d.id, false).catch((err) =>
          this.opts.logger?.warn?.('drivebucket: failed to trash duplicate', { bucket, fileId: d.id, error: String(err) }),
        );
      }
    }
    await this.index.set(bucket, key, newest.id);
    return newest;
  }

  private toInfo(file: DriveFile, key: string): ObjectInfo {
    const decoded = decodeObjectProps(file.appProperties, file.description);
    const info: ObjectInfo = {
      key,
      size: Number(file.size ?? 0),
      etag: file.md5Checksum ?? '',
      contentType: file.mimeType ?? DEFAULT_CONTENT_TYPE,
      lastModified: new Date(file.modifiedTime ?? 0),
      metadata: decoded?.metadata ?? {},
      fileId: file.id,
    };
    if (decoded?.cacheControl !== undefined) info.cacheControl = decoded.cacheControl;
    return info;
  }

  // ---------------------------------------------------------------- object ops

  async head(bucket: string, key: string): Promise<ObjectInfo> {
    validateKey(key);
    const folderId = await this.bucketFolder(bucket);
    const file = await this.findObject(bucket, key, folderId);
    if (!file) throw new NoSuchKey(bucket, key);
    return this.toInfo(file, key);
  }

  async get(bucket: string, key: string, opts: GetOptions = {}): Promise<GetResult> {
    const info = await this.head(bucket, key);
    if (opts.ifMatch !== undefined && !etagMatches(info.etag, opts.ifMatch)) throw new PreconditionFailed();
    return this.read(bucket, info, opts.range !== undefined ? { range: opts.range } : {});
  }

  /**
   * Open the content of an object already resolved with `head()`. Lets callers (the HTTP proxy)
   * evaluate conditional headers on metadata first and skip a second lookup.
   */
  async read(bucket: string, info: ObjectInfo, opts: { range?: ByteRange } = {}): Promise<GetResult> {
    const range = opts.range ? resolveRange(opts.range, info.size) : undefined;
    let media;
    try {
      media = await this.call('files.get(media)', () => this.api.getMedia(info.fileId, range));
    } catch (err) {
      if (is404(err)) {
        await this.index.delete(bucket, info.key);
        throw new NoSuchKey(bucket, info.key, { cause: err });
      }
      throw err;
    }
    const result: GetResult = {
      ...info,
      stream: media.stream,
      contentLength: range ? range.end - range.start + 1 : info.size,
    };
    if (range) result.range = { ...range, total: info.size };
    return result;
  }

  async put(bucket: string, key: string, body: Body, opts: PutOptions = {}): Promise<PutResult> {
    validateKey(key);
    const contentType = opts.contentType ?? DEFAULT_CONTENT_TYPE;
    if (contentType.startsWith('application/vnd.google-apps.')) {
      throw new DriveBucketError('Google Workspace MIME types cannot be stored as objects', { code: 'InvalidArgument', status: 400 });
    }
    if (opts.contentLength !== undefined && this.opts.maxObjectBytes !== undefined && opts.contentLength > this.opts.maxObjectBytes) {
      throw new DriveBucketError(`Body exceeds max size of ${this.opts.maxObjectBytes} bytes`, { code: 'EntityTooLarge', status: 400 });
    }
    const folderId = await this.bucketFolder(bucket);

    return this.withKeyLock(bucket, key, async () => {
      const existing = await this.findObject(bucket, key, folderId);
      if (opts.ifNoneMatch === '*' && existing) throw new PreconditionFailed();
      if (opts.ifMatch !== undefined && !etagMatches(existing?.md5Checksum, opts.ifMatch)) throw new PreconditionFailed();

      const meta = this.objectMeta(bucket, key, contentType, opts, folderId, existing);
      const file = await this.upload(body, meta, contentType, existing?.id, opts.contentLength, opts.expectedMd5);
      await this.index.set(bucket, key, file.id);
      return { key, etag: file.md5Checksum ?? '', size: Number(file.size ?? 0), fileId: file.id };
    });
  }

  /** Multipart for ≤5 MB bodies, resumable sessions above. Verifies MD5 end to end. */
  private async upload(
    body: Body,
    meta: FileMetadataInput,
    contentType: string,
    fileId: string | undefined,
    contentLength?: number,
    expectedMd5?: string,
  ): Promise<DriveFile> {
    const max = this.opts.maxObjectBytes;
    let small: Buffer | undefined;
    let reader: ChunkReader | undefined;
    let first: Buffer;

    if (isReadable(body)) {
      reader = new ChunkReader(body, max);
      first = await reader.read(MULTIPART_MAX + 1);
      if (first.length <= MULTIPART_MAX && !(await reader.hasMore())) small = first;
    } else {
      first = toBuffer(body);
      if (max !== undefined && first.length > max) {
        throw new DriveBucketError(`Body exceeds max size of ${max} bytes`, { code: 'EntityTooLarge', status: 400 });
      }
      if (first.length <= MULTIPART_MAX) small = first;
    }

    const check = (md5: string, size: number) => {
      if (contentLength !== undefined && contentLength !== size) {
        throw new DriveBucketError(`Body was ${size} bytes but contentLength said ${contentLength}`, { code: 'IncompleteBody', status: 400 });
      }
      if (expectedMd5 !== undefined && expectedMd5.toLowerCase() !== md5) throw new BadDigest();
    };

    if (small) {
      const md5 = reader ? reader.md5.digest('hex') : createMd5(small);
      check(md5, small.length);
      const media = { mimeType: contentType, body: small };
      const file = fileId
        ? await this.call('files.update(multipart)', () => this.api.updateFile(fileId, meta, media, FILE_FIELDS))
        : await this.call('files.create(multipart)', () => this.api.createFile(meta, media, FILE_FIELDS));
      return verifyMd5(file, md5);
    }

    const knownTotal = reader ? contentLength : first.length;
    const writer = await this.startResumable(meta, contentType, fileId, knownTotal);
    await writer.write(first);
    if (reader) {
      for (;;) {
        const more = await reader.read(this.chunkSize);
        if (more.length === 0) break;
        await writer.write(more);
      }
    }
    // Validate before the final chunk: until then Drive has not created/replaced anything.
    return writer.finish(check);
  }

  private async startResumable(meta: FileMetadataInput, contentType: string, fileId: string | undefined, total?: number): Promise<ResumableWriter> {
    const sessionUri = await this.call(fileId ? 'files.update(resumable-start)' : 'files.create(resumable-start)', () =>
      this.api.startResumable({
        ...(fileId ? { fileId } : {}),
        meta,
        contentType,
        ...(total !== undefined ? { contentLength: total } : {}),
        fields: FILE_FIELDS,
      }),
    );
    return new ResumableWriter(sessionUri, this.chunkSize, total, this.opts.maxObjectBytes, (uri, buf, start, t) => this.sendChunk(uri, buf, start, t));
  }

  /**
   * Begin a streaming upload whose bytes arrive over time (S3 multipart). Bytes go to a Drive
   * resumable session as they arrive; nothing is visible until `complete()`. Single-process:
   * the session state lives in this object.
   */
  async createUpload(bucket: string, key: string, opts: Omit<PutOptions, 'contentLength'> = {}): Promise<ObjectUpload> {
    validateKey(key);
    const contentType = opts.contentType ?? DEFAULT_CONTENT_TYPE;
    if (contentType.startsWith('application/vnd.google-apps.')) {
      throw new DriveBucketError('Google Workspace MIME types cannot be stored as objects', { code: 'InvalidArgument', status: 400 });
    }
    const folderId = await this.bucketFolder(bucket);
    const existing = await this.findObject(bucket, key, folderId);
    if (opts.ifNoneMatch === '*' && existing) throw new PreconditionFailed();
    if (opts.ifMatch !== undefined && !etagMatches(existing?.md5Checksum, opts.ifMatch)) throw new PreconditionFailed();
    const meta = this.objectMeta(bucket, key, contentType, opts, folderId, existing);
    const writer = await this.startResumable(meta, contentType, existing?.id);
    let state: 'open' | 'done' | 'aborted' = 'open';
    return {
      get bytesWritten() {
        return writer.size;
      },
      write: async (chunk: Buffer) => {
        if (state !== 'open') throw new DriveBucketError('Upload is no longer open', { code: 'NoSuchUpload', status: 404 });
        await writer.write(chunk);
      },
      complete: async (check?: (md5: string, size: number) => void) => {
        if (state !== 'open') throw new DriveBucketError('Upload is no longer open', { code: 'NoSuchUpload', status: 404 });
        state = 'done';
        const file = await writer.finish(check);
        await this.index.set(bucket, key, file.id);
        return { key, etag: file.md5Checksum ?? '', size: Number(file.size ?? 0), fileId: file.id };
      },
      abort: () => {
        // Drive has no explicit cancel for resumable sessions; an unfinished session expires
        // after a week and never becomes a file.
        state = 'aborted';
      },
    };
  }

  private objectMeta(
    bucket: string,
    key: string,
    contentType: string,
    opts: Pick<PutOptions, 'metadata' | 'cacheControl'>,
    folderId: string,
    existing: DriveFile | undefined,
  ): FileMetadataInput {
    const encoded = encodeObjectProps(
      { bucket, key, metadata: opts.metadata ?? {}, ...(opts.cacheControl !== undefined ? { cacheControl: opts.cacheControl } : {}) },
      existing?.appProperties,
    );
    const meta: FileMetadataInput = { name: fileNameForKey(key), mimeType: contentType };
    if (existing) {
      meta.appProperties = encoded.appProperties;
      if (encoded.description !== null) meta.description = encoded.description;
      else if (existing.appProperties?.[PROP_SPILL] === '1') meta.description = '';
    } else {
      meta.parents = [folderId];
      meta.appProperties = Object.fromEntries(Object.entries(encoded.appProperties).filter(([, v]) => v !== null));
      if (encoded.description !== null) meta.description = encoded.description;
    }
    return meta;
  }

  /**
   * Send [start, start+buf.length). On a retryable failure, ask Drive how much it has and
   * resend only the missing tail. Drive may also acknowledge fewer bytes than sent (308 with a
   * short Range), in which case the remainder is resent.
   */
  private sendChunk(sessionUri: string, buf: Buffer, start: number, total: number | undefined): Promise<ChunkResult> {
    const end = start + buf.length;
    return this.limit(() =>
      withRetry(
        async (attempt) => {
          let sent = 0;
          if (attempt > 0) {
            const q = await this.api.queryResumable(sessionUri, total);
            if (q.done) return q;
            sent = Math.max(0, q.received - start);
            if (q.received >= end) return q;
          }
          for (;;) {
            const t0 = performance.now();
            const res = await this.api.putChunk(sessionUri, buf.subarray(sent), start + sent, total).catch((err) => {
              const status = (err as { response?: { status?: number } })?.response?.status;
              this.emitCall({ op: 'upload.chunk', durationMs: performance.now() - t0, ok: false, ...(status !== undefined ? { status } : {}) });
              if (status === 404) {
                throw new DriveApiError('Resumable upload session expired; restart the upload', { status: 404, cause: err });
              }
              throw err;
            });
            this.emitCall({ op: 'upload.chunk', durationMs: performance.now() - t0, ok: true });
            if (res.done || res.received >= end) return res;
            const newSent = Math.max(0, res.received - start);
            if (newSent <= sent) throw new DriveApiError('Resumable upload made no progress', { status: 502, retryable: true });
            sent = newSent;
          }
        },
        this.retryFor('upload.chunk'),
        'upload.chunk',
      ),
    );
  }

  async delete(bucket: string, key: string, opts: DeleteOptions = {}): Promise<DeleteResult> {
    validateKey(key);
    const folderId = await this.bucketFolder(bucket);
    return this.withKeyLock(bucket, key, async () => {
      const existing = await this.findObject(bucket, key, folderId);
      if (opts.ifMatch !== undefined && !etagMatches(existing?.md5Checksum, opts.ifMatch)) throw new PreconditionFailed();
      if (!existing) return { deleted: false };
      try {
        await this.removeFile(existing.id, opts.permanent ?? this.opts.permanentDelete ?? false);
      } catch (err) {
        if (!is404(err)) throw err;
      }
      await this.index.delete(bucket, key);
      return { deleted: true };
    });
  }

  async copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string, opts: CopyOptions = {}): Promise<PutResult> {
    validateKey(srcKey);
    validateKey(dstKey);
    const srcFolder = await this.bucketFolder(srcBucket);
    const dstFolder = await this.bucketFolder(dstBucket);
    const src = await this.findObject(srcBucket, srcKey, srcFolder);
    if (!src) throw new NoSuchKey(srcBucket, srcKey);
    if (opts.ifMatch !== undefined && !etagMatches(src.md5Checksum, opts.ifMatch)) throw new PreconditionFailed();

    const srcProps = decodeObjectProps(src.appProperties, src.description);
    const replace = opts.metadata !== undefined;
    const metadata = replace ? opts.metadata! : (srcProps?.metadata ?? {});
    const cacheControl = replace ? opts.cacheControl : (opts.cacheControl ?? srcProps?.cacheControl);
    const contentType = opts.contentType ?? src.mimeType ?? DEFAULT_CONTENT_TYPE;
    const sameObject = srcBucket === dstBucket && srcKey === dstKey;

    return this.withKeyLock(dstBucket, dstKey, async () => {
      const existingDst = sameObject ? src : await this.findObject(dstBucket, dstKey, dstFolder);
      const encoded = encodeObjectProps(
        { bucket: dstBucket, key: dstKey, metadata, ...(cacheControl !== undefined ? { cacheControl } : {}) },
        src.appProperties,
      );
      const description = encoded.description ?? (src.appProperties?.[PROP_SPILL] === '1' ? '' : undefined);

      if (sameObject) {
        // S3 "copy onto itself" = metadata update. Keep the same file id.
        const file = await this.call('files.update', () =>
          this.api.updateFile(src.id, { mimeType: contentType, appProperties: encoded.appProperties, ...(description !== undefined ? { description } : {}) }, undefined, FILE_FIELDS),
        );
        return { key: dstKey, etag: file.md5Checksum ?? '', size: Number(file.size ?? 0), fileId: file.id };
      }

      const copied = await this.call('files.copy', () =>
        this.api.copyFile(
          src.id,
          {
            name: fileNameForKey(dstKey),
            parents: [dstFolder],
            mimeType: contentType,
            appProperties: encoded.appProperties,
            ...(description !== undefined ? { description } : {}),
          },
          FILE_FIELDS,
        ),
      );
      if (existingDst && existingDst.id !== copied.id) {
        await this.removeFile(existingDst.id, this.opts.permanentDelete ?? false).catch((err) => {
          if (!is404(err)) throw err;
        });
      }
      await this.index.set(dstBucket, dstKey, copied.id);
      return { key: dstKey, etag: copied.md5Checksum ?? src.md5Checksum ?? '', size: Number(copied.size ?? src.size ?? 0), fileId: copied.id };
    });
  }

  /**
   * List objects. Drive cannot filter by key prefix or sort by appProperties, so this scans the
   * whole bucket folder (1000 files per page, 100 quota units per page) and sorts locally.
   */
  async list(bucket: string, opts: ListOptions = {}): Promise<ListResult> {
    const folderId = await this.bucketFolder(bucket);
    const prefix = opts.prefix ?? '';
    const delimiter = opts.delimiter || undefined;
    const maxKeys = Math.max(0, Math.min(opts.maxKeys ?? 1000, 1000));
    const token: ContinuationToken | undefined = opts.continuationToken
      ? decodeToken(opts.continuationToken)
      : opts.startAfter
        ? { k: opts.startAfter }
        : undefined;

    const newest = new Map<string, DriveFile>();
    const q =
      `'${escapeQuery(folderId)}' in parents and trashed=false ` +
      `and appProperties has { key='${PROP_MARKER}' and value='object' }`;
    let pageToken: string | undefined;
    do {
      const pt = pageToken;
      const res = await this.call('files.list', () =>
        this.api.listFiles({ q, fields: LIST_FIELDS, pageSize: 1000, ...(pt ? { pageToken: pt } : {}) }),
      );
      for (const f of res.files) {
        const d = decodeObjectProps(f.appProperties, f.description);
        if (!d || d.bucket !== bucket) continue;
        const prev = newest.get(d.key);
        if (!prev || Date.parse(f.modifiedTime ?? '0') > Date.parse(prev.modifiedTime ?? '0')) newest.set(d.key, f);
      }
      pageToken = res.nextPageToken;
    } while (pageToken);

    for (const [key, f] of newest) void this.index.set(bucket, key, f.id).catch(() => undefined);

    const keys = [...newest.keys()]
      .filter((k) => k.startsWith(prefix))
      .filter((k) => !token || (compareKeys(k, token.k) > 0 && !(token.p && k.startsWith(token.k))))
      .sort(compareKeys);

    const objects: ObjectSummary[] = [];
    const commonPrefixes: string[] = [];
    let last: ContinuationToken | undefined;
    let isTruncated = false;
    for (const key of keys) {
      let cp: string | undefined;
      if (delimiter) {
        const idx = key.indexOf(delimiter, prefix.length);
        if (idx >= 0) cp = key.slice(0, idx + delimiter.length);
      }
      if (cp !== undefined && commonPrefixes[commonPrefixes.length - 1] === cp) continue;
      if (objects.length + commonPrefixes.length >= maxKeys) {
        isTruncated = true;
        break;
      }
      if (cp !== undefined) {
        commonPrefixes.push(cp);
        last = { k: cp, p: 1 };
      } else {
        const f = newest.get(key)!;
        objects.push({
          key,
          size: Number(f.size ?? 0),
          etag: f.md5Checksum ?? '',
          lastModified: new Date(f.modifiedTime ?? 0),
          contentType: f.mimeType ?? DEFAULT_CONTENT_TYPE,
        });
        last = { k: key };
      }
    }

    const result: ListResult = { objects, commonPrefixes, isTruncated, keyCount: objects.length + commonPrefixes.length };
    if (isTruncated && last) result.nextContinuationToken = encodeToken(last);
    return result;
  }

  /** A StorageAdapter bound to one bucket. */
  bucket(name: string): StorageAdapter {
    validateBucketName(name);
    return {
      bucket: name,
      put: (key, body, o) => this.put(name, key, body, o),
      get: (key, o) => this.get(name, key, o),
      head: (key) => this.head(name, key),
      delete: (key, o) => this.delete(name, key, o),
      list: (o) => this.list(name, o),
      copy: (src, dst, o) => this.copy(name, src, name, dst, o),
    };
  }
}

function verifyMd5(file: DriveFile, md5: string): DriveFile {
  if (file.md5Checksum && file.md5Checksum !== md5) {
    throw new DriveApiError(`MD5 mismatch after upload (sent ${md5}, Drive has ${file.md5Checksum})`, { status: 500 });
  }
  return file;
}

type SendChunk = (uri: string, buf: Buffer, start: number, total: number | undefined) => Promise<ChunkResult>;

/**
 * Feeds bytes into a Drive resumable session. Non-final chunks are exact multiples of the
 * chunk size (itself a multiple of 256 KiB); the remainder is held back until more bytes
 * arrive or `finish()` sends it as the final chunk.
 */
class ResumableWriter {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private offset = 0;
  private readonly md5 = createHash('md5');
  size = 0;

  constructor(
    private readonly uri: string,
    private readonly chunkSize: number,
    private readonly total: number | undefined,
    private readonly maxBytes: number | undefined,
    private readonly send: SendChunk,
  ) {}

  async write(buf: Buffer): Promise<void> {
    if (buf.length === 0) return;
    this.size += buf.length;
    if (this.maxBytes !== undefined && this.size > this.maxBytes) {
      throw new DriveBucketError(`Body exceeds max size of ${this.maxBytes} bytes`, { code: 'EntityTooLarge', status: 400 });
    }
    this.md5.update(buf);
    this.pending.push(buf);
    this.pendingLen += buf.length;
    // Strictly greater: always keep ≥1 byte back so the final chunk is never empty.
    while (this.pendingLen > this.chunkSize) {
      const all = Buffer.concat(this.pending, this.pendingLen);
      const chunk = all.subarray(0, this.chunkSize);
      const rest = all.subarray(this.chunkSize);
      await this.send(this.uri, chunk, this.offset, this.total);
      this.offset += chunk.length;
      this.pending = rest.length ? [rest] : [];
      this.pendingLen = rest.length;
    }
  }

  async finish(check?: (md5: string, size: number) => void): Promise<DriveFile> {
    const md5 = this.md5.digest('hex');
    check?.(md5, this.size);
    const last = Buffer.concat(this.pending, this.pendingLen);
    const res = await this.send(this.uri, last, this.offset, this.offset + last.length);
    if (!res.done) throw new DriveApiError('Resumable upload did not complete after final chunk', { status: 502 });
    return verifyMd5(res.file, md5);
  }
}

function createMd5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}
