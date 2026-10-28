import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  createStorage,
  OBJECT_STORAGE,
} from '@request-management/share';
import type { ObjectStorage, StorageOptions } from '@request-management/share';

const refuse = (): Promise<never> =>
  Promise.reject(
    new AppError(
      'STORAGE_UNAVAILABLE',
      'external-service ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (MINIO_*) — ดาวน์โหลดเอกสารไม่ได้',
    ),
  );

/**
 * The object storage for company documents, scoped to this module.
 *
 * Unlike the post-deal routes (`common/no-file-storage.ts`), downloading the
 * file is the point here, so the real store is wired when it is configured.
 * When it is not, the port still boots and the download names the missing
 * configuration instead of the process failing to start.
 */
export const DocumentStorage: Provider = {
  provide: OBJECT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ObjectStorage => {
    const options = config.get<StorageOptions>('storage');
    return options
      ? createStorage(options)
      : { put: refuse, get: refuse, remove: refuse };
  },
};
