import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { DocumentFilesService } from './document-files.service';
import { DocumentsController } from './documents.controller';
import { DocumentsModule } from './documents.module';

/** The screen-facing routes of {@link DocumentsModule}. */
@Module({
  imports: [
    DocumentsModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentFilesService],
})
export class DocumentsHttpModule {}
