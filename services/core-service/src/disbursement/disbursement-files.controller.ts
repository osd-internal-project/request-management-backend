import {
  Body,
  Controller,
  Delete,
  Get,
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
import {
  DisbursementFilesService,
  DISBURSEMENT_FILE_KINDS,
  MAX_FILE_BYTES,
} from './disbursement-files.service';

/** การเบิก — evidence files. Screen-only: see `DisbursementFilesService`. */
@ApiTags('disbursement')
@ApiBearerAuth()
@Controller('disbursements')
export class DisbursementFilesController {
  constructor(private readonly files: DisbursementFilesService) {}

  @ApiOperation({ summary: 'แนบไฟล์หลักฐาน (สลิป / ใบเสร็จ / หลักฐานคืนเงิน)' })
  @Post(':docNo/files')
  @Permissions('request.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['kind', 'file'],
      properties: {
        kind: { type: 'string', enum: [...DISBURSEMENT_FILE_KINDS] },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Param('docNo') docNo: string,
    @Body('kind') kind: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.files.upload(principal, docNo, kind, file);
  }

  @ApiOperation({ summary: 'เปิดไฟล์หลักฐาน' })
  @Get(':docNo/files/:fileId')
  @Permissions('request.read')
  async download(
    @Param('docNo') docNo: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.files.download(principal, docNo, fileId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'ลบไฟล์หลักฐาน (ซ่อน — ไฟล์ยังอยู่ในคลัง)' })
  @Delete(':docNo/files/:fileId')
  @Permissions('request.read')
  remove(
    @Param('docNo') docNo: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.files.remove(principal, docNo, fileId);
  }
}
