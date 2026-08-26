import { Global, Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer.service';

/**
 * Global because SUP-04 is a cross-cutting obligation: every module that
 * changes something has to record it, and requiring each to remember an import
 * is how an unaudited write eventually slips through.
 */
@Global()
@Module({
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
