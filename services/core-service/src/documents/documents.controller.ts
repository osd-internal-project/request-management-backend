import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { MAX_DOCUMENT_BYTES } from './document-rules';
import { documentStream } from './document-stream';
import { DocumentFilesService } from './document-files.service';
import {
  CreateDocumentDto,
  ListDocumentsQueryDto,
  UpdateDocumentDto,
} from './documents.dto';
import { DocumentsService } from './documents.service';

/** Company documents in settings — upload, edit, archive, open. */
@ApiTags('admin-documents')
@ApiBearerAuth()
@Controller('admin/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly files: DocumentFilesService,
  ) {}

  @ApiOperation({ summary: 'เอกสารบริษัท — รายการ (รวมที่เลิกใช้ได้)' })
  @Get()
  @Permissions('admin.document.manage')
  list(
    @Query() query: ListDocumentsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.documents.list(
      principal.activeCompanyId,
      query,
      query.include_archived === 'true',
    );
  }

  @ApiOperation({ summary: 'เอกสารบริษัท — รายละเอียด' })
  @Get(':id')
  @Permissions('admin.document.manage')
  one(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.documents.one(principal.activeCompanyId, id, true);
  }

  @ApiOperation({
    summary:
      'อัปโหลดเอกสาร — kind = dated ต้องมี issue_date (YYYY-MM-DD) · general ไม่มี',
  })
  @Post()
  @Permissions('admin.document.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_DOCUMENT_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Body() dto: CreateDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.files.upload(principal, dto, file);
  }

  @ApiOperation({ summary: 'แก้ชื่อ คำอธิบาย วันที่ออกเอกสาร' })
  @Patch(':id')
  @Permissions('admin.document.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.documents.update(principal, id, dto);
  }

  @ApiOperation({
    summary: 'เลิกใช้เอกสาร (ไม่แสดงใน External API เก็บประวัติไว้)',
  })
  @Post(':id/archive')
  @Permissions('admin.document.manage')
  archive(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.documents.archive(principal, id, true);
  }

  @ApiOperation({ summary: 'เปิดใช้เอกสารที่เลิกใช้กลับมา' })
  @Post(':id/restore')
  @Permissions('admin.document.manage')
  restore(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.documents.archive(principal, id, false);
  }

  @ApiOperation({ summary: 'เปิด/ดาวน์โหลดไฟล์' })
  @Get(':id/file')
  @Permissions('admin.document.manage')
  async file(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return documentStream(await this.files.file(principal, id, 'screen'));
  }
}
