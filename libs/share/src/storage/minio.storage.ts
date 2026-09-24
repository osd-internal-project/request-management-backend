import { Logger, OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';
import type { Readable } from 'node:stream';
import { AppError } from '../errors';
import type { MinioOptions, ObjectMeta, ObjectStorage } from './object-storage';

export class MinioStorage implements ObjectStorage, OnModuleInit {
  private readonly logger = new Logger(MinioStorage.name);
  private readonly client: Client;

  constructor(private readonly options: MinioOptions) {
    this.client = new Client({
      endPoint: options.endPoint,
      port: options.port,
      useSSL: options.useSSL,
      accessKey: options.accessKey,
      secretKey: options.secretKey,
    });
  }

  /** Warns instead of failing boot, so a storage outage only breaks uploads. */
  async onModuleInit(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.options.bucket);
      if (exists) {
        this.logger.log(`bucket "${this.options.bucket}" พร้อมใช้งาน`);
      } else {
        this.logger.warn(`ไม่พบ bucket "${this.options.bucket}" — อัปโหลดไฟล์จะล้ม`);
      }
    } catch (error) {
      this.logger.warn(`ต่อ MinIO ไม่ได้: ${describe(error)}`);
    }
  }

  async put(key: string, body: Buffer, meta: ObjectMeta): Promise<void> {
    try {
      await this.client.putObject(this.options.bucket, key, body, meta.size, {
        'Content-Type': meta.contentType,
      });
    } catch (error) {
      throw this.unavailable('put', key, error);
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      return await this.client.getObject(this.options.bucket, key);
    } catch (error) {
      if (errorCode(error) === 'NoSuchKey') {
        throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
      }
      throw this.unavailable('get', key, error);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.options.bucket, key);
    } catch (error) {
      throw this.unavailable('remove', key, error);
    }
  }

  private unavailable(action: string, key: string, error: unknown): AppError {
    this.logger.error(`MinIO ${action} ${key} ล้ม: ${describe(error)}`);
    return new AppError('STORAGE_UNAVAILABLE', 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งาน');
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
