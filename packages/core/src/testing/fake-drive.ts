import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ChunkResult, DriveApi, DriveFile, FileMetadataInput, ListParams, MediaResponse } from '../drive-api.js';

/** Build an error shaped like a gaxios error from googleapis. */
export function httpError(status: number, reason?: string, opts: { message?: string; headers?: Record<string, string> } = {}) {
  const message = opts.message ?? `${status} ${reason ?? 'error'}`;
  const err = new Error(message) as Error & { response: unknown; status: number };
  err.status = status;
  err.response = {
    status,
    headers: opts.headers ?? {},
    data: { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } },
  };
  return err;
}

interface Stored {
  file: DriveFile;
  content: Buffer;
}

interface Session {
  fileId?: string;
  meta: FileMetadataInput;
  contentType: string;
  data: Buffer;
}

type Op = keyof DriveApi;

const FOLDER = 'application/vnd.google-apps.folder';

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

const STR = `'((?:\\\\.|[^'\\\\])*)'`;

/** Parse the subset of Drive `q` syntax that DriveAdapter emits into a predicate. */
export function compileQuery(q: string): (f: DriveFile) => boolean {
  const preds: Array<(f: DriveFile) => boolean> = [];
  let rest = q;
  const take = (re: RegExp, make: (m: RegExpExecArray) => (f: DriveFile) => boolean) => {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(rest))) preds.push(make(m));
    rest = rest.replace(g, '');
  };
  take(new RegExp(`appProperties has \\{ key=${STR} and value=${STR} \\}`), (m) => {
    const k = unescape(m[1]!);
    const v = unescape(m[2]!);
    return (f) => f.appProperties?.[k] === v;
  });
  take(new RegExp(`${STR} in parents`), (m) => {
    const id = unescape(m[1]!);
    return (f) => (f.parents ?? []).includes(id);
  });
  take(new RegExp(`mimeType=${STR}`), (m) => {
    const v = unescape(m[1]!);
    return (f) => f.mimeType === v;
  });
  take(new RegExp(`name=${STR}`), (m) => {
    const v = unescape(m[1]!);
    return (f) => f.name === v;
  });
  take(/trashed=(true|false)/, (m) => {
    const v = m[1] === 'true';
    return (f) => Boolean(f.trashed) === v;
  });
  const leftover = rest.replace(/\band\b/g, '').trim();
  if (leftover) throw new Error(`FakeDrive cannot parse query fragment: ${leftover}`);
  return (f) => preds.every((p) => p(f));
}

/**
 * In-memory stand-in for the Drive v3 API surface DriveAdapter uses. Enforces the real
 * constraints we depend on: 124-byte appProperty limit, 30 props, 256 KiB chunk alignment.
 */
export class FakeDrive implements DriveApi {
  readonly files = new Map<string, Stored>();
  readonly sessions = new Map<string, Session>();
  readonly sharedDrives = new Set<string>();
  readonly calls: Array<{ op: Op; args: unknown[] }> = [];
  private faults: Array<{ op: Op; err: unknown; remaining: number }> = [];
  private seq = 0;
  private clock = Date.parse('2026-01-01T00:00:00Z');
  inFlight = 0;
  maxInFlight = 0;
  /** Artificial latency per call (ms), to observe concurrency. */
  latencyMs = 0;
  /** Acknowledge at most this many bytes per non-final chunk (simulates short 308 Range). */
  shortAckBytes: number | undefined;
  /** What `getAbout()` reports. `limit` undefined = unlimited (pooled Workspace storage). */
  about: { email: string; limit?: number; usage: number } = { email: 'tester@example.com', limit: 15 * 1024 ** 3, usage: 1024 ** 3 };

  constructor() {
    this.files.set('root', { file: { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [] }, content: Buffer.alloc(0) });
  }

  failNext(op: Op, err: unknown, times = 1): void {
    this.faults.push({ op, err, remaining: times });
  }

  count(op: Op): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private async enter(op: Op, args: unknown[]): Promise<void> {
    this.calls.push({ op, args });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
      const fault = this.faults.find((f) => f.op === op && f.remaining > 0);
      if (fault) {
        fault.remaining--;
        throw fault.err;
      }
    } finally {
      this.inFlight--;
    }
  }

  private mustGet(id: string): Stored {
    const s = this.files.get(id);
    if (!s) throw httpError(404, 'notFound', { message: `File not found: ${id}` });
    return s;
  }

  private applyProps(target: DriveFile, props: Record<string, string | null> | undefined): void {
    if (!props) return;
    const merged: Record<string, string> = { ...(target.appProperties ?? {}) };
    for (const [k, v] of Object.entries(props)) {
      if (v === null) delete merged[k];
      else {
        if (Buffer.byteLength(k) + Buffer.byteLength(v) > 124) throw httpError(400, 'badRequest', { message: `Property too large: ${k}` });
        merged[k] = v;
      }
    }
    if (Object.keys(merged).length > 30) throw httpError(400, 'badRequest', { message: 'Too many properties' });
    target.appProperties = merged;
  }

  private setContent(s: Stored, content: Buffer): void {
    s.content = content;
    s.file.size = String(content.length);
    s.file.md5Checksum = createHash('md5').update(content).digest('hex');
  }

  private applyMeta(s: Stored, meta: FileMetadataInput): void {
    if (meta.name !== undefined) s.file.name = meta.name;
    if (meta.mimeType !== undefined) s.file.mimeType = meta.mimeType;
    if (meta.parents !== undefined) {
      for (const p of meta.parents) this.mustGet(p);
      s.file.parents = meta.parents;
    }
    if (meta.description !== undefined) s.file.description = meta.description;
    if (meta.trashed !== undefined) s.file.trashed = meta.trashed;
    this.applyProps(s.file, meta.appProperties);
    s.file.modifiedTime = this.now();
  }

  private newFile(meta: FileMetadataInput, content: Buffer | undefined): Stored {
    const id = `f${++this.seq}`;
    const t = this.now();
    const s: Stored = { file: { id, createdTime: t, modifiedTime: t, trashed: false, parents: [] }, content: Buffer.alloc(0) };
    this.applyMeta(s, meta);
    const parentDrive = s.file.parents?.[0] ? (this.files.get(s.file.parents[0])?.file.driveId ?? null) : null;
    if (parentDrive) s.file.driveId = parentDrive;
    if (content && meta.mimeType !== FOLDER) this.setContent(s, content);
    this.files.set(id, s);
    return s;
  }

  private snapshot(s: Stored): DriveFile {
    return structuredClone(s.file);
  }

  /** Test helper: create a file directly (bypassing faults/call log). */
  seed(meta: FileMetadataInput, content?: Buffer): DriveFile {
    return this.snapshot(this.newFile(meta, content));
  }

  addSharedDrive(id: string): void {
    this.sharedDrives.add(id);
    this.files.set(id, { file: { id, name: id, mimeType: FOLDER, parents: [], driveId: id }, content: Buffer.alloc(0) });
  }

  async createFile(meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined): Promise<DriveFile> {
    await this.enter('createFile', [meta, media]);
    return this.snapshot(this.newFile(meta, media?.body ?? Buffer.alloc(0)));
  }

  async updateFile(fileId: string, meta: FileMetadataInput, media: { mimeType: string; body: Buffer } | undefined): Promise<DriveFile> {
    await this.enter('updateFile', [fileId, meta, media]);
    const s = this.mustGet(fileId);
    this.applyMeta(s, meta);
    if (media) this.setContent(s, media.body);
    return this.snapshot(s);
  }

  async getFile(fileId: string): Promise<DriveFile> {
    await this.enter('getFile', [fileId]);
    return this.snapshot(this.mustGet(fileId));
  }

  async getMedia(fileId: string, range?: { start: number; end: number }): Promise<MediaResponse> {
    await this.enter('getMedia', [fileId, range]);
    const s = this.mustGet(fileId);
    const buf = range ? s.content.subarray(range.start, range.end + 1) : s.content;
    return { stream: Readable.from([Buffer.from(buf)]), status: range ? 206 : 200 };
  }

  async listFiles(params: ListParams): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    await this.enter('listFiles', [params]);
    const pred = compileQuery(params.q);
    let all = [...this.files.values()].filter((s) => s.file.id !== 'root' && pred(s.file)).map((s) => this.snapshot(s));
    if (params.orderBy?.startsWith('modifiedTime desc')) all.sort((a, b) => Date.parse(b.modifiedTime!) - Date.parse(a.modifiedTime!));
    else if (params.orderBy?.startsWith('createdTime')) all.sort((a, b) => Date.parse(a.createdTime!) - Date.parse(b.createdTime!));
    const size = Math.min(params.pageSize ?? 100, 1000);
    const start = params.pageToken ? Number(params.pageToken) : 0;
    all = all.slice(start);
    const page = all.slice(0, size);
    const out: { files: DriveFile[]; nextPageToken?: string } = { files: page };
    if (all.length > size) out.nextPageToken = String(start + size);
    return out;
  }

  async copyFile(fileId: string, meta: FileMetadataInput): Promise<DriveFile> {
    await this.enter('copyFile', [fileId, meta]);
    const src = this.mustGet(fileId);
    const copy = this.newFile(
      {
        name: src.file.name ?? 'copy',
        mimeType: src.file.mimeType ?? 'application/octet-stream',
        appProperties: { ...(src.file.appProperties ?? {}) },
        ...(src.file.description ? { description: src.file.description } : {}),
        parents: src.file.parents ?? [],
      },
      src.content,
    );
    this.applyMeta(copy, meta);
    return this.snapshot(copy);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.enter('deleteFile', [fileId]);
    this.mustGet(fileId);
    this.files.delete(fileId);
  }

  async getDrive(driveId: string): Promise<{ id: string; name?: string | null }> {
    await this.enter('getDrive', [driveId]);
    if (!this.sharedDrives.has(driveId)) throw httpError(404, 'notFound', { message: `Shared drive not found: ${driveId}` });
    return { id: driveId, name: driveId };
  }

  async getAbout() {
    await this.enter('getAbout', []);
    return {
      user: { emailAddress: this.about.email },
      storageQuota: { ...(this.about.limit !== undefined ? { limit: String(this.about.limit) } : {}), usage: String(this.about.usage) },
    };
  }

  async startResumable(params: { fileId?: string; meta: FileMetadataInput; contentType: string; contentLength?: number }): Promise<string> {
    await this.enter('startResumable', [params]);
    if (params.fileId) this.mustGet(params.fileId);
    const uri = `https://upload.fake/session/${++this.seq}`;
    this.sessions.set(uri, {
      ...(params.fileId ? { fileId: params.fileId } : {}),
      meta: params.meta,
      contentType: params.contentType,
      data: Buffer.alloc(0),
    });
    return uri;
  }

  private finish(session: Session): DriveFile {
    if (session.fileId) {
      const s = this.mustGet(session.fileId);
      this.applyMeta(s, session.meta);
      this.setContent(s, session.data);
      return this.snapshot(s);
    }
    return this.snapshot(this.newFile({ ...session.meta, mimeType: session.meta.mimeType ?? session.contentType }, session.data));
  }

  async putChunk(sessionUri: string, chunk: Buffer, start: number, total: number | undefined): Promise<ChunkResult> {
    await this.enter('putChunk', [sessionUri, chunk.length, start, total]);
    const session = this.sessions.get(sessionUri);
    if (!session) throw httpError(404, 'notFound');
    if (start !== session.data.length) throw httpError(400, 'badRequest', { message: `Bad offset ${start}, have ${session.data.length}` });
    const isFinal = total !== undefined && start + chunk.length === total;
    if (!isFinal && chunk.length % (256 * 1024) !== 0) {
      throw httpError(400, 'badRequest', { message: `Non-final chunk not a multiple of 256 KiB: ${chunk.length}` });
    }
    let accepted = chunk;
    if (!isFinal && this.shortAckBytes !== undefined && chunk.length > this.shortAckBytes) {
      accepted = chunk.subarray(0, this.shortAckBytes);
    }
    session.data = Buffer.concat([session.data, accepted]);
    if (isFinal) {
      this.sessions.delete(sessionUri);
      return { done: true, file: this.finish(session) };
    }
    return { done: false, received: session.data.length };
  }

  async queryResumable(sessionUri: string): Promise<ChunkResult> {
    await this.enter('queryResumable', [sessionUri]);
    const session = this.sessions.get(sessionUri);
    if (!session) throw httpError(404, 'notFound');
    return { done: false, received: session.data.length };
  }
}
