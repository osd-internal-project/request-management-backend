import type { Provider } from '@nestjs/common';
import { AppError, OBJECT_STORAGE } from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';

/**
 * The object storage of this process: none.
 *
 * Several services the post-deal routes reuse (`SolutionsService`,
 * `LegalContractsService`, `MilestonesService`) keep files, so they inject
 * `OBJECT_STORAGE`. The routes this service serves from them only read rows —
 * no upload, no download — and external-service deliberately boots without
 * storage configuration (see `CrmHttpModule`'s comment on the visit photos).
 * Wiring the real `StorageModule` here would make MinIO credentials a boot
 * requirement of the external port for bytes it never moves.
 *
 * So the token resolves to a store that refuses. If a route here ever reaches
 * a file, the caller gets `STORAGE_UNAVAILABLE` naming the reason, rather than
 * the process failing to start — and that answer is the cue to serve the file
 * from core-service, where the bytes are.
 */
const refuse = (): Promise<never> =>
  Promise.reject(
    new AppError(
      'STORAGE_UNAVAILABLE',
      'External API ไม่เปิดไฟล์แนบ — ดาวน์โหลดจากหน้าเว็บ',
    ),
  );

const NO_FILES: ObjectStorage = {
  put: refuse,
  get: refuse,
  remove: refuse,
};

export const NoFileStorage: Provider = {
  provide: OBJECT_STORAGE,
  useValue: NO_FILES,
};
