import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { LeadFilesService, MAX_LEAD_FILE_BYTES } from './lead-files.service';

/** The multipart body both ports document the same way. */
export const LEAD_FILE_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string', format: 'binary' },
      kind: {
        type: 'string',
        enum: ['proposal', 'other'],
        description: 'proposal = ไฟล์ที่แนบไปกับอีเมลขอบคุณ (ใช้ฉบับล่าสุด)',
      },
    },
  },
};

export const LEAD_FILE_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: MAX_LEAD_FILE_BYTES },
  defParamCharset: 'utf8',
});

/**
 * Files on a Lead (6 พ.ย. 2569), for the screens. Not in
 * `generate-crm-controllers.py`, like the visit photos: the generator does not
 * carry multipart decorators. Vuvagent uploads through `crm/ai/leads/:id/files`.
 */
@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadFilesController {
  constructor(private readonly files: LeadFilesService) {}

  @ApiOperation({ summary: 'ไฟล์บน Lead (ล่าสุดก่อน)' })
  @Get(':id/files')
  @Permissions('crm.lead.read')
  list(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.files.list(id, principal);
  }

  @ApiOperation({
    summary: 'วางไฟล์บน Lead (PDF/Word/PowerPoint/Excel/รูป ≤ 20 MB)',
  })
  @Post(':id/files')
  @Permissions('crm.lead.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody(LEAD_FILE_BODY)
  @UseInterceptors(LEAD_FILE_UPLOAD)
  upload(
    @Param('id') id: string,
    @Body('kind') kind: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.files.upload(id, kind, file, principal);
  }

  @ApiOperation({ summary: 'ดาวน์โหลดไฟล์บน Lead' })
  @Get(':id/files/:fileId')
  @Permissions('crm.lead.read')
  async download(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const { file, stream } = await this.files.download(id, fileId, principal);
    return new StreamableFile(stream, {
      type: file.mime_type,
      length: file.size_bytes,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    });
  }

  @ApiOperation({ summary: 'นำไฟล์ออกจาก Lead' })
  @Delete(':id/files/:fileId')
  @Permissions('crm.lead.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.files.remove(id, fileId, principal);
  }
}
