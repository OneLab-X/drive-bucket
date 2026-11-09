import { Readable } from 'node:stream';
import { drive as driveFactory, type drive_v3 } from '@googleapis/drive';
import type { AuthClient } from './auth.js';

/** Subset of the Drive File resource drivebucket uses. */
export interface DriveFile {
  id: string;
  name?: string | null;
  mimeType?: string | null;
  size?: string | null;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  createdTime?: string | null;
  appProperties?: Record<string, string> | null;
  description?: string | null;
  trashed?: boolean | null;
  driveId?: string | null;
  parents?: string[] | null;
}

export interface FileMetadataInput {
  name?: string;
  mimeType?: string;
  parents?: string[];
  appProperties?: Record<string, string | null>;
  description?: string | null;
  trashed?: boolean;
}

export interface ListParams {
  q: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  fields: string;
}

export type ChunkResult = { done: true; file: DriveFile } | { done: false; received: number };

export interface MediaResponse {
  stream: Readable;
  status: number;
}

/**
 * The narrow slice of Drive v3 that DriveAdapter talks to. `GoogleDriveApi` implements it on top
 * of `@googleapis/drive`; tests swap in an in-memory fake. Implementations throw gaxios-shaped
 * errors (`{ response: { status, headers, data } }`) so retry classification is shared.
 */
export interface DriveApi {
  createFile(meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined, fields: string): Promise<DriveFile>;
  updateFile(fileId: string, meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined, fields: string): Promise<DriveFile>;
  getFile(fileId: string, fields: string): Promise<DriveFile>;
  getMedia(fileId: string, range?: { start: number; end: number }): Promise<MediaResponse>;
  listFiles(params: ListParams): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  copyFile(fileId: string, meta: FileMetadataInput, fields: string): Promise<DriveFile>;
  deleteFile(fileId: string): Promise<void>;
  getDrive(driveId: string): Promise<{ id: string; name?: string | null }>;
  /** Start a resumable session; returns the session URI. `fileId` = overwrite existing file. */
  startResumable(params: { fileId?: string; meta: FileMetadataInput; contentType: string; contentLength?: number; fields: string }): Promise<string>;
  /** Upload bytes [start, start+chunk.length). `total` undefined = more chunks follow. */
  putChunk(sessionUri: string, chunk: Buffer, start: number, total: number | undefined): Promise<ChunkResult>;
  /** Ask the server how much of the session it has. */
  queryResumable(sessionUri: string, total: number | undefined): Promise<ChunkResult>;
  getAbout?(): Promise<{ storageQuota?: { limit?: string | null; usage?: string | null } | null; user?: { emailAddress?: string | null } | null }>;
}

const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const v = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Parse a resumable `Range: bytes=0-N` header into the count of bytes received. */
export function parseReceived(range: string | undefined): number {
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

export interface GoogleDriveApiOptions {
  auth: AuthClient;
  /** Shared drive to scope list queries to (corpora=drive). */
  sharedDriveId?: string;
}

/** Real Drive v3 implementation. Always passes supportsAllDrives=true. */
export class GoogleDriveApi implements DriveApi {
  private readonly drive: drive_v3.Drive;
  private readonly auth: AuthClient;
  private readonly sharedDriveId: string | undefined;

  constructor(opts: GoogleDriveApiOptions) {
    this.auth = opts.auth;
    this.sharedDriveId = opts.sharedDriveId;
    this.drive = driveFactory({ version: 'v3', auth: opts.auth as never });
  }

  async createFile(meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined, fields: string): Promise<DriveFile> {
    const res = await this.drive.files.create({
      requestBody: meta as drive_v3.Schema$File,
      ...(media ? { media: { mimeType: media.mimeType, body: Readable.from([media.body]) } } : {}),
      fields,
      supportsAllDrives: true,
    });
    return res.data as DriveFile;
  }

  async updateFile(fileId: string, meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined, fields: string): Promise<DriveFile> {
    const res = await this.drive.files.update({
      fileId,
      requestBody: meta as drive_v3.Schema$File,
      ...(media ? { media: { mimeType: media.mimeType, body: Readable.from([media.body]) } } : {}),
      fields,
      supportsAllDrives: true,
    });
    return res.data as DriveFile;
  }

  async getFile(fileId: string, fields: string): Promise<DriveFile> {
    const res = await this.drive.files.get({ fileId, fields, supportsAllDrives: true });
    return res.data as DriveFile;
  }

  async getMedia(fileId: string, range?: { start: number; end: number }): Promise<MediaResponse> {
    // Not via drive.files.get: googleapis forces `Accept-Encoding: gzip`, which breaks byte-exact
    // passthrough (Content-Length / Range) for proxies.
    const qs = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    const res = await this.auth.request<Readable>({
      url: `${API_BASE}/${encodeURIComponent(fileId)}?${qs.toString()}`,
      method: 'GET',
      headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) },
      responseType: 'stream',
    } as never);
    return { stream: res.data, status: res.status };
  }

  async listFiles(params: ListParams): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const res = await this.drive.files.list({
      q: params.q,
      fields: params.fields,
      pageSize: params.pageSize ?? 1000,
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      ...(params.orderBy ? { orderBy: params.orderBy } : {}),
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(this.sharedDriveId ? { corpora: 'drive', driveId: this.sharedDriveId } : { corpora: 'user' }),
    });
    const out: { files: DriveFile[]; nextPageToken?: string } = { files: (res.data.files ?? []) as DriveFile[] };
    if (res.data.nextPageToken) out.nextPageToken = res.data.nextPageToken;
    return out;
  }

  async copyFile(fileId: string, meta: FileMetadataInput, fields: string): Promise<DriveFile> {
    const res = await this.drive.files.copy({
      fileId,
      requestBody: meta as drive_v3.Schema$File,
      fields,
      supportsAllDrives: true,
    });
    return res.data as DriveFile;
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.drive.files.delete({ fileId, supportsAllDrives: true });
  }

  async getDrive(driveId: string): Promise<{ id: string; name?: string | null }> {
    const res = await this.drive.drives.get({ driveId, fields: 'id,name' });
    return { id: res.data.id ?? driveId, name: res.data.name ?? null };
  }

  async getAbout() {
    const res = await this.drive.about.get({ fields: 'user(emailAddress),storageQuota(limit,usage)' });
    return res.data;
  }

  async startResumable(params: { fileId?: string; meta: FileMetadataInput; contentType: string; contentLength?: number; fields: string }): Promise<string> {
    const url = params.fileId
      ? `${UPLOAD_BASE}/${encodeURIComponent(params.fileId)}`
      : UPLOAD_BASE;
    const qs = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: params.fields });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': params.contentType,
    };
    if (params.contentLength !== undefined) headers['X-Upload-Content-Length'] = String(params.contentLength);
    const res = await this.auth.request({
      url: `${url}?${qs.toString()}`,
      method: params.fileId ? 'PATCH' : 'POST',
      headers,
      data: JSON.stringify(params.meta),
    });
    const location = header(res.headers, 'location');
    if (!location) throw Object.assign(new Error('Resumable session start returned no Location header'), { response: { status: 502 } });
    return location;
  }

  async putChunk(sessionUri: string, chunk: Buffer, start: number, total: number | undefined): Promise<ChunkResult> {
    const end = start + chunk.length - 1;
    const contentRange =
      chunk.length === 0 ? `bytes */${total ?? '*'}` : `bytes ${start}-${end}/${total ?? '*'}`;
    return this.sendSession(sessionUri, chunk, contentRange);
  }

  async queryResumable(sessionUri: string, total: number | undefined): Promise<ChunkResult> {
    return this.sendSession(sessionUri, Buffer.alloc(0), `bytes */${total ?? '*'}`);
  }

  private async sendSession(sessionUri: string, body: Buffer, contentRange: string): Promise<ChunkResult> {
    const res = await this.auth.request({
      url: sessionUri,
      method: 'PUT',
      headers: { 'Content-Range': contentRange, 'Content-Length': String(body.length) },
      data: body,
      // 308 = Resume Incomplete, not a redirect.
      validateStatus: (s: number) => (s >= 200 && s < 300) || s === 308,
      maxRedirects: 0,
    } as never);
    if (res.status === 308) return { done: false, received: parseReceived(header(res.headers, 'range')) };
    const data = typeof res.data === 'string' ? (JSON.parse(res.data) as DriveFile) : (res.data as DriveFile);
    return { done: true, file: data };
  }
}
