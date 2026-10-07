import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  DocumentFilesService,
  DocumentsQueryDto,
  DocumentsService,
  documentStream,
} from '@request-management/core-service';

/**
 * Company documents uploaded in settings, for other systems: list them,
 * read a document's issue date, and download the file. A key holding
 * `integration.document.read`.
 *
 * Robot-only like `kb/ai`: the documents belong to the company, not to a
 * person, so no `X-Acting-User`. The company is the key's (or
 * `X-Company-Id` for a key bound to none). Archived documents do not
 * exist here (404); every download is audited.
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsApiController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly files: DocumentFilesService,
  ) {}

  @Get()
  @Permissions('integration.document.read')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'รายการเอกสารบริษัท พร้อมวันที่ออกเอกสาร',
    description:
      'kind = dated (มีวันที่ออกเอกสาร) | general (ทั่วไป) · กรองวันที่ออกด้วย issued_from / issued_to (YYYY-MM-DD) · q ค้นชื่อ/คำอธิบาย/ชื่อไฟล์ · issue_date เป็น YYYY-MM-DD หรือ null สำหรับเอกสารทั่วไป · ดาวน์โหลดที่ GET documents/:id/file',
  })
  list(
    @Query() query: DocumentsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.documents.list(principal.activeCompanyId, query);
  }

  @Get(':id')
  @Permissions('integration.document.read')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'รายละเอียดเอกสาร — วันที่ออกเอกสาร ชื่อไฟล์ ขนาด',
  })
  one(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.documents.one(principal.activeCompanyId, id);
  }

  @Get(':id/file')
  @Permissions('integration.document.read')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ดาวน์โหลดไฟล์เอกสาร',
    description:
      'ตอบเป็นไฟล์ (Content-Type ตามชนิดไฟล์, Content-Disposition มีชื่อไฟล์แบบ UTF-8) · บันทึก audit ทุกครั้ง',
  })
  async file(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return documentStream(await this.files.file(principal, id, 'external'));
  }
}
