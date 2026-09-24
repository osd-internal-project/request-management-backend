import { Readable } from 'node:stream';
import { AppError } from '../errors';
import type { ObjectMeta, ObjectStorage } from './object-storage';

/** In-process storage for tests and `STORAGE_MODE=memory`; lost on restart. */
export class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, { body: Buffer; meta: ObjectMeta }>();

  async put(key: string, body: Buffer, meta: ObjectMeta): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), meta });
  }

  async get(key: string): Promise<Readable> {
    const found = this.objects.get(key);
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return Readable.from(found.body);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
