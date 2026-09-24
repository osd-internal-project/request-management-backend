import type { Readable } from 'node:stream';

/** Injection token for the active {@link ObjectStorage} implementation. */
export const OBJECT_STORAGE = 'OBJECT_STORAGE';

export interface ObjectMeta {
  readonly contentType: string;
  readonly size: number;
}

/**
 * Where uploaded bytes live. Callers own the key layout; implementations only
 * move bytes. Failures surface as `AppError('STORAGE_UNAVAILABLE')`.
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, meta: ObjectMeta): Promise<void>;
  /** Throws `AppError('NOT_FOUND')` when the key holds nothing. */
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

export interface MinioOptions {
  readonly endPoint: string;
  readonly port: number;
  readonly useSSL: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
}

export interface StorageOptions {
  readonly mode: string;
  readonly minio: MinioOptions;
}
