import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CompanyDocumentRepository } from './documents.repositories';
import { DocumentsService } from './documents.service';

/**
 * Company documents (settings): dated documents carry the day they were
 * issued, general ones none. External systems read and download them
 * through `integration.document.read`.
 */
@Module({
  imports: [AccessModule],
  providers: [DocumentsService, CompanyDocumentRepository],
  exports: [DocumentsService, CompanyDocumentRepository],
})
export class DocumentsModule {}
