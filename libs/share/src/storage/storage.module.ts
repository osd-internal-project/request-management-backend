import {
  DynamicModule,
  FactoryProvider,
  Module,
  ModuleMetadata,
} from '@nestjs/common';
import { MemoryStorage } from './memory.storage';
import { MinioStorage } from './minio.storage';
import {
  OBJECT_STORAGE,
  ObjectStorage,
  StorageOptions,
} from './object-storage';

export interface StorageModuleAsyncOptions
  extends Pick<FactoryProvider<StorageOptions | undefined>, 'inject' | 'useFactory'> {
  readonly imports?: ModuleMetadata['imports'];
}

/**
 * Shared object storage. Each service passes its own config, since
 * `libs/share` does not depend on `@nestjs/config`.
 */
@Module({})
export class StorageModule {
  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: OBJECT_STORAGE,
          inject: options.inject ?? [],
          useFactory: async (...args: unknown[]) =>
            createStorage(await options.useFactory(...args)),
        },
      ],
      exports: [OBJECT_STORAGE],
    };
  }
}

/** Picks the implementation for `mode`; an unknown mode stops boot. */
export function createStorage(options: StorageOptions | undefined): ObjectStorage {
  const mode = options?.mode ?? 'memory';
  if (mode === 'memory') return new MemoryStorage();
  if (mode === 'minio' && options) {
    const missing = (['endPoint', 'bucket', 'accessKey', 'secretKey'] as const)
      .filter((key) => !options.minio[key]);
    if (missing.length > 0) {
      throw new Error(`STORAGE_MODE=minio แต่ขาดค่า: ${missing.join(', ')}`);
    }
    return new MinioStorage(options.minio);
  }
  throw new Error(`STORAGE_MODE=${mode} ไม่รู้จัก — ใช้ minio หรือ memory`);
}
