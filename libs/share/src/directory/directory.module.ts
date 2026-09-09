import { Global, Module } from '@nestjs/common';
import { DirectoryRepository } from './directory.repository';
import { DirectoryService } from './directory.service';

/**
 * Global for the same reason {@link AuditModule} is: two services need it and
 * a third will, and requiring each to remember an import is how the second
 * implementation gets written instead.
 */
@Global()
@Module({
  providers: [DirectoryRepository, DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
