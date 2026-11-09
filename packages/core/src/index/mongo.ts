import { keyHash } from '../keys.js';
import type { KeyIndex } from './types.js';

export interface MongoIndexDoc {
  _id: string;
  bucket: string;
  key: string;
  fileId: string;
  updatedAt: Date;
}

/** Minimal subset of a MongoDB `Collection<MongoIndexDoc>`. */
export interface MongoCollectionLike {
  findOne(filter: { _id: string }): Promise<Pick<MongoIndexDoc, 'fileId'> | null>;
  updateOne(
    filter: { _id: string },
    update: { $set: Omit<MongoIndexDoc, '_id'> },
    options: { upsert: boolean },
  ): Promise<unknown>;
  deleteOne(filter: { _id: string }): Promise<unknown>;
}

/**
 * MongoDB-backed index. Add a TTL index on `updatedAt` if you want expiry:
 * `db.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 })`.
 */
export class MongoKeyIndex implements KeyIndex {
  constructor(private readonly collection: MongoCollectionLike) {}

  async get(bucket: string, key: string): Promise<string | undefined> {
    const doc = await this.collection.findOne({ _id: keyHash(bucket, key) });
    return doc?.fileId ?? undefined;
  }

  async set(bucket: string, key: string, fileId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: keyHash(bucket, key) },
      { $set: { bucket, key, fileId, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.collection.deleteOne({ _id: keyHash(bucket, key) });
  }
}
