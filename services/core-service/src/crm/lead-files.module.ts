import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  createStorage,
  OBJECT_STORAGE,
} from '@request-management/share';
import type { ObjectStorage, StorageOptions } from '@request-management/share';
import { CrmModule } from './crm.module';
import { LeadFilesService } from './lead-files.service';
import { LeadFileRepository } from './sales.repositories';

const refuse = (): Promise<never> =>
  Promise.reject(
    new AppError(
      'STORAGE_UNAVAILABLE',
      'ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (MINIO_*) — ไฟล์บน Lead ใช้ไม่ได้',
    ),
  );

/**
 * Files on a Lead (6 พ.ย. 2569) — the domain half, with its own object
 * storage: imported by core's screens (`LeadFilesHttpModule`), by the sales
 * mail (the proposal it attaches) and by external-service, where Vuvagent
 * uploads and the thank-you email is sent. External-service has storage only
 * when `MINIO_*` is set; without it the port still boots and these files
 * answer `STORAGE_UNAVAILABLE`, as company documents do.
 */
@Module({
  imports: [CrmModule],
  providers: [
    LeadFileRepository,
    LeadFilesService,
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ObjectStorage => {
        const options = config.get<StorageOptions>('storage');
        return options
          ? createStorage(options)
          : { put: refuse, get: refuse, remove: refuse };
      },
    },
  ],
  exports: [LeadFilesService],
})
export class LeadFilesModule {}
