import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { PartnerFileDto, SavePartnerDto } from './dto/partner.dto';
import { MAX_PARTNER_FILE_BYTES, PartnersService } from './partners.service';

/**
 * CD-142 — ข้อมูลคู่ค้า, for the screens only: SAP's suppliers with the
 * technical profile Pre-Sales keeps on each. Keyed by the SAP code.
 */
@ApiTags('presales')
@ApiBearerAuth()
@Controller('presales/partners')
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @ApiOperation({
    summary: 'CD-142 รายชื่อผู้ขายจาก SAP พร้อมข้อมูลทางเทคนิคที่บันทึกไว้',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({
    name: 'active',
    required: false,
    description: '1 = เฉพาะผู้ขายที่ไม่ถูกระงับใน SAP',
  })
  @Get()
  @Permissions('presales.solution.read', 'presales.solution.manage')
  list(
    @CurrentPrincipal() actor: Principal,
    @Query('q') q?: string,
    @Query('active') active?: string,
  ) {
    return this.partners.list(actor, q, active === '1' || active === 'true');
  }

  @ApiOperation({
    summary: 'CD-142 คู่ค้า — ข้อมูลจาก SAP + ข้อมูลทางเทคนิค + เอกสาร',
  })
  @Get(':code')
  @Permissions('presales.solution.read', 'presales.solution.manage')
  findOne(@Param('code') code: string, @CurrentPrincipal() actor: Principal) {
    return this.partners.findOne(code, actor);
  }

  @ApiOperation({ summary: 'CD-142 บันทึกข้อมูลทางเทคนิคของคู่ค้า' })
  @Put(':code')
  @Permissions('presales.solution.manage')
  save(
    @Param('code') code: string,
    @Body() dto: SavePartnerDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.partners.save(code, dto, actor);
  }

  @ApiOperation({ summary: 'CD-142 แนบเอกสารอ้างอิงของคู่ค้า (≤ 25 MB)' })
  @Post(':code/files')
  @Permissions('presales.solution.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        category: {
          type: 'string',
          enum: ['certificate', 'datasheet', 'catalog', 'other'],
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PARTNER_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Param('code') code: string,
    @Body() dto: PartnerFileDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.partners.uploadFile(code, dto.category, file, actor);
  }

  @ApiOperation({ summary: 'CD-142 เอกสารของคู่ค้า' })
  @Get(':code/files/:fileId')
  @Permissions('presales.solution.read', 'presales.solution.manage')
  async download(
    @Param('code') code: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ): Promise<StreamableFile> {
    const file = await this.partners.downloadFile(code, fileId, actor);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'CD-142 เอาเอกสารของคู่ค้าออก' })
  @Delete(':code/files/:fileId')
  @Permissions('presales.solution.manage')
  removeFile(
    @Param('code') code: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.partners.removeFile(code, fileId, actor);
  }
}
