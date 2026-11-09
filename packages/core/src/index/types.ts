/**
 * Maps (bucket, key) -> Drive file id. A cache, not a source of truth: a miss falls back to a
 * Drive `files.list` lookup, and a stale hit (404 from Drive) is evicted and re-resolved.
 * Share one Redis/Mongo index between server replicas to cut Drive list calls.
 */
export interface KeyIndex {
  get(bucket: string, key: string): Promise<string | undefined>;
  set(bucket: string, key: string, fileId: string): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
}
