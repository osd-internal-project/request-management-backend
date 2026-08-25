import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditLogRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * Global because every module writes to the log — threading an import of this
 * through each of them would add noise without adding clarity.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditLogRepository],
  exports: [AuditService],
})
export class AuditModule {}
