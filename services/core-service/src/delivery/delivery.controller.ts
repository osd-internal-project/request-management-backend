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
  ApiTags,
} from '@nestjs/swagger';
import { MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { DeliveryDocsService } from './delivery-docs.service';
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AttachDeliveryDocumentDto,
  CancelDeliveryDto,
  ListDeliveriesQueryDto,
  SaveDeliveryDto,
} from './delivery.dto';
import { DeliveriesService } from './deliveries.service';

/** CD-20 Delivery — ส่งมอบและตรวจรับ. */
@ApiTags('delivery')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly docs: DeliveryDocsService,
  ) {}

  // --- CD-251 ชุดเอกสารส่งมอบ ---------------------------------------------------

  @ApiOperation({
    summary:
      'CD-251 ชุดเอกสารส่งมอบรายเฟส: เอกสารบังคับตามประเภทงาน ที่แนบแล้ว และที่ขาด',
  })
  @Get('projects/:projectId/documents')
  @Authenticated()
  documents(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.docs.view(principal, projectId);
  }

  @ApiOperation({ summary: 'CD-251 แนบเอกสารส่งมอบของเฟส (ทีมโครงการ)' })
  @Post('projects/:projectId/documents')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['milestone_id', 'title', 'file'],
      properties: {
        milestone_id: { type: 'string' },
        title: { type: 'string' },
        note: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  attachDocument(
    @Param('projectId') projectId: string,
    @Body() dto: AttachDeliveryDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.docs.attach(principal, projectId, dto, file);
  }

  @ApiOperation({
    summary: 'CD-251 ลบเอกสารส่งมอบ (ผู้แนบ / ทีม Delivery / ผู้จัดการ)',
  })
  @Delete('projects/:projectId/documents/:documentId')
  @Authenticated()
  removeDocument(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.docs.remove(principal, projectId, documentId);
  }

  @ApiOperation({ summary: 'CD-251 ไฟล์เอกสารส่งมอบ' })
  @Get('projects/:projectId/documents/:documentId/file')
  @Authenticated()
  async documentFile(
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.docs.download(principal, projectId, documentId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({
    summary: 'CD-250 รอบส่งของทุกโครงการ (ของไม่พร้อมใกล้วันส่งขึ้นเตือน)',
  })
  @Get('deliveries')
  @AnyPermission('delivery.read', 'delivery.manage', 'pm.project.read')
  list(
    @Query() query: ListDeliveriesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.list(principal, query);
  }

  @ApiOperation({
    summary:
      'CD-250 แผนส่งมอบของโครงการ: รอบส่ง หมุดหมาย และ BOQ ที่วางแผนแล้ว',
  })
  @Get('projects/:projectId')
  @Authenticated()
  project(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.project(principal, projectId);
  }

  @ApiOperation({
    summary: 'CD-250 เพิ่มรอบส่ง (ทีม Delivery / ผู้จัดการโครงการ)',
  })
  @Post('projects/:projectId/deliveries')
  @Authenticated()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: SaveDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.create(principal, projectId, dto);
  }

  @ApiOperation({ summary: 'CD-250 แก้รอบส่ง (เลื่อนวัน = เตือนใหม่)' })
  @Put('deliveries/:id')
  @Authenticated()
  update(
    @Param('id') id: string,
    @Body() dto: SaveDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-250 ยกเลิกรอบส่ง (ต้องมีเหตุผล)' })
  @Post('deliveries/:id/cancel')
  @Authenticated()
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deliveries.cancel(principal, id, dto.reason);
  }
}
