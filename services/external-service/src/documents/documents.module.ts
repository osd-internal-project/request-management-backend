import { Module } from '@nestjs/common';
import {
  DocumentFilesService,
  DocumentsModule,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { DocumentStorage } from './document-storage';
import { DocumentsApiController } from './documents.controller';

/** `api/v1/documents/*` — company documents uploaded in settings. */
@Module({
  imports: [DocumentsModule, AuthModule],
  controllers: [DocumentsApiController],
  providers: [DocumentFilesService, DocumentStorage],
})
export class DocumentsApiModule {}
