import type { Readable } from 'node:stream';

export type Body = Readable | Buffer | Uint8Array | string;

export interface PutOptions {
  contentType?: string;
  /** User metadata (S3 x-amz-meta-*). Names are lowercased. Max 2 KB total. */
  metadata?: Record<string, string>;
  cacheControl?: string;
  /** Known body length. Lets resumable uploads declare the total up front. */
  contentLength?: number;
  /** Best-effort conditional write: only overwrite if the current etag matches. Not atomic. */
  ifMatch?: string;
  /** `*` = only create if the key does not exist. Best effort, not atomic. */
  ifNoneMatch?: '*';
  /** Hex MD5 the body must match (S3 Content-MD5). Checked before anything is committed. */
  expectedMd5?: string;
}

/** A streaming upload in progress (see DriveAdapter.createUpload). */
export interface ObjectUpload {
  readonly bytesWritten: number;
  write(chunk: Buffer): Promise<void>;
  /** Commit. `check(md5, size)` may throw to refuse before Drive creates/replaces the file. */
  complete(check?: (md5: string, size: number) => void): Promise<PutResult>;
  abort(): void;
}

export interface PutResult {
  key: string;
  etag: string;
  size: number;
  fileId: string;
}

export type ByteRange = { start: number; end?: number } | { suffix: number };

export interface GetOptions {
  range?: ByteRange;
  ifMatch?: string;
}

export interface ObjectInfo {
  key: string;
  size: number;
  /** MD5 hex digest of the content, unquoted. */
  etag: string;
  contentType: string;
  lastModified: Date;
  metadata: Record<string, string>;
  cacheControl?: string;
  fileId: string;
}

export interface GetResult extends ObjectInfo {
  stream: Readable;
  /** Bytes in `stream` (equals `size` when no range was requested). */
  contentLength: number;
  /** Resolved inclusive range when one was requested. */
  range?: { start: number; end: number; total: number };
}

export interface ListOptions {
  prefix?: string;
  delimiter?: string;
  continuationToken?: string;
  startAfter?: string;
  /** 1..1000, default 1000. */
  maxKeys?: number;
}

export interface ObjectSummary {
  key: string;
  size: number;
  etag: string;
  lastModified: Date;
  contentType: string;
}

export interface ListResult {
  objects: ObjectSummary[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
  keyCount: number;
}

export interface CopyOptions {
  /** Replace metadata instead of copying it (S3 MetadataDirective=REPLACE). */
  metadata?: Record<string, string>;
  contentType?: string;
  cacheControl?: string;
  /** Best-effort: only copy if the source etag matches. */
  ifMatch?: string;
}

export interface DeleteOptions {
  ifMatch?: string;
  /** Override the adapter default (trash). */
  permanent?: boolean;
}

export interface DeleteResult {
  /** False when the key did not exist (S3 DeleteObject is still a success then). */
  deleted: boolean;
}

/** Storage bound to one bucket. */
export interface StorageAdapter {
  readonly bucket: string;
  put(key: string, body: Body, opts?: PutOptions): Promise<PutResult>;
  get(key: string, opts?: GetOptions): Promise<GetResult>;
  head(key: string): Promise<ObjectInfo>;
  delete(key: string, opts?: DeleteOptions): Promise<DeleteResult>;
  list(opts?: ListOptions): Promise<ListResult>;
  copy(srcKey: string, dstKey: string, opts?: CopyOptions): Promise<PutResult>;
}

export interface BucketInfo {
  name: string;
  createdAt: Date;
  folderId: string;
}
