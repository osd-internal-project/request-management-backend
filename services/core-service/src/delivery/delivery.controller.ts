import type { Request } from 'express';
import {
  Body,
  Controller,
  Delete,
  Headers,
  ParseIntPipe,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
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
import { InstallConfirmationsService } from './install-confirmations.service';
import { AcceptanceCertificatesService } from './acceptance-certificates.service';
import { InstallmentBillingService } from './installment-billing.service';
import { ServiceHandoversService } from './service-handovers.service';
import { metaOf } from '../esign/esign.controller';
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AnswerHandoverDto,
  AttachDeliveryDocumentDto,
  ListHandoversQueryDto,
  SendHandoverDto,
  CancelDeliveryDto,
  ConfirmInstallDto,
  PaperCertificateDto,
  SendCertificateDto,
  SendInstallmentDto,
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
    private readonly installs: InstallConfirmationsService,
    private readonly certificates: AcceptanceCertificatesService,
    private readonly billing: InstallmentBillingService,
    private readonly handovers: ServiceHandoversService,
  ) {}

  // --- CD-255 ส่งมอบให้ทีมบริการ ----------------------------------------------------

  @ApiOperation({
    summary:
      'CD-255 รอบตรวจรับของโครงการ: สิ่งที่จะส่งต่อและสถานะการรับทราบของทีมบริการ',
  })
  @Get('projects/:projectId/handovers')
  @Authenticated()
  handoversOfProject(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.projectView(principal, projectId);
  }

  @ApiOperation({
    summary:
      'CD-255 ส่งต่อรอบตรวจรับให้ทีมบริการ (ทีม Delivery / ผู้จัดการโครงการ — ส่งซ้ำเพื่อตอบคำถาม)',
  })
  @Post('projects/:projectId/handovers/:acceptanceId/send')
  @Authenticated()
  sendHandover(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: SendHandoverDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.send(
      principal,
      projectId,
      acceptanceId,
      dto.note ?? '',
    );
  }

  @ApiOperation({ summary: 'CD-255 กล่องงานส่งมอบของทีมบริการ' })
  @Get('handovers')
  @AnyPermission(
    'service.asset.read',
    'service.asset.manage',
    'delivery.read',
    'delivery.manage',
  )
  handoverInbox(
    @Query() query: ListHandoversQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.inbox(principal, query.status);
  }

  @ApiOperation({ summary: 'CD-255 ทีมบริการรับทราบ หรือส่งคำถามกลับ' })
  @Post('handovers/:id/answer')
  @AnyPermission('service.asset.manage')
  answerHandover(
    @Param('id') id: string,
    @Body() dto: AnswerHandoverDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return dto.action === 'acknowledge'
      ? this.handovers.acknowledge(principal, id, dto.text ?? '')
      : this.handovers.ask(principal, id, dto.text ?? '');
  }

  // --- CD-253 วางบิลรายงวด ---------------------------------------------------------

  @ApiOperation({
    summary: 'CD-253 งวดของสัญญา: สถานะวางบิล/SAP และสิ่งที่ยังขวาง',
  })
  @Get('projects/:projectId/billing')
  @Authenticated()
  billingView(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.view(principal, projectId);
  }

  @ApiOperation({
    summary: 'CD-253 ส่งวางบิลงวดเข้า SAP (ผู้จัดการโครงการ — เงื่อนไขต้องครบ)',
  })
  @Post('projects/:projectId/billing/:seq/send')
  @Authenticated()
  sendInstallment(
    @Param('projectId') projectId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: SendInstallmentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.send(principal, projectId, seq, dto.note ?? '');
  }

  @ApiOperation({ summary: 'CD-253 ถอนการวางบิล (ก่อนการเงินออกใบแจ้งหนี้)' })
  @Post('projects/:projectId/billing/:seq/cancel')
  @Authenticated()
  cancelInstallment(
    @Param('projectId') projectId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: CancelDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.cancel(principal, projectId, seq, dto.reason);
  }

  @ApiOperation({
    summary: 'CD-253 ขอยกเว้นวางบิลก่อนปิดรายการค้าง (คำขอให้ผู้บริหารอนุมัติ)',
  })
  @Post('projects/:projectId/billing/:seq/exception')
  @Authenticated()
  requestBillingException(
    @Param('projectId') projectId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: CancelDeliveryDto,
    @Headers('authorization') authorization: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billing.requestException(
      principal,
      projectId,
      seq,
      dto.reason,
      authorization ?? '',
    );
  }

  // --- CD-252 ใบรับรองการตรวจรับ ---------------------------------------------------

  @ApiOperation({
    summary: 'CD-252 ใบรับรองการตรวจรับของทุกรอบที่บันทึกผลรับมอบแล้ว',
  })
  @Get('projects/:projectId/certificates')
  @Authenticated()
  certificateList(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.certificates.list(principal, projectId);
  }

  @ApiOperation({
    summary: 'CD-252 ร่างใบรับรองจากผลตรวจรับ (สร้างใหม่ได้ก่อนส่ง)',
  })
  @Post('projects/:projectId/certificates/:acceptanceId/draft')
  @Authenticated()
  draftCertificate(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.certificates.generate(principal, projectId, acceptanceId);
  }

  @ApiOperation({ summary: 'CD-252 ส่งใบรับรองลงนามอิเล็กทรอนิกส์' })
  @Post('projects/:projectId/certificates/:acceptanceId/send')
  @Authenticated()
  sendCertificate(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: SendCertificateDto,
    @Req() request: Request,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.certificates.send(
      principal,
      projectId,
      acceptanceId,
      dto,
      metaOf(request),
    );
  }

  @ApiOperation({ summary: 'CD-252 ถอนใบรับรองที่ส่งลงนาม (ต้องมีเหตุผล)' })
  @Post('projects/:projectId/certificates/:acceptanceId/withdraw')
  @Authenticated()
  withdrawCertificate(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: CancelDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.certificates.withdraw(
      principal,
      projectId,
      acceptanceId,
      dto.reason,
    );
  }

  @ApiOperation({
    summary: 'CD-252 บันทึกใบรับรองที่ลูกค้าลงนามบนกระดาษ (สแกน + เหตุผล)',
  })
  @Post('projects/:projectId/certificates/:acceptanceId/paper')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string' },
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
  paperCertificate(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: PaperCertificateDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.certificates.paper(
      principal,
      projectId,
      acceptanceId,
      dto.reason,
      file,
    );
  }

  @ApiOperation({ summary: 'CD-252 ไฟล์ใบรับรอง (ร่าง หรือฉบับลงนาม)' })
  @Get('projects/:projectId/certificates/:acceptanceId/:which')
  @Authenticated()
  async certificateFile(
    @Param('projectId') projectId: string,
    @Param('acceptanceId') acceptanceId: string,
    @Param('which') which: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.certificates.file(
      principal,
      projectId,
      acceptanceId,
      which === 'signed' ? 'signed' : 'draft',
    );
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-254 ยืนยันงานติดตั้งเสร็จ ----------------------------------------------

  @ApiOperation({
    summary: 'CD-254 สิ่งที่ยังขวางการยืนยันติดตั้งเสร็จ (จากการตรวจความพร้อม)',
  })
  @Get('projects/:projectId/install-gate')
  @Authenticated()
  installGate(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installs.gate(principal, projectId);
  }

  @ApiOperation({
    summary:
      'CD-254 ยืนยันงานติดตั้งของเฟสเสร็จ (ผู้จัดการโครงการ) — แจ้งทีม Delivery',
  })
  @Post('projects/:projectId/phases/:milestoneId/install')
  @Authenticated()
  confirmInstall(
    @Param('projectId') projectId: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: ConfirmInstallDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installs.confirm(
      principal,
      projectId,
      milestoneId,
      dto.note ?? '',
    );
  }

  @ApiOperation({
    summary: 'CD-254 ยกเลิกการยืนยันติดตั้งเสร็จ (ต้องมีเหตุผล)',
  })
  @Post('projects/:projectId/phases/:milestoneId/install/revoke')
  @Authenticated()
  revokeInstall(
    @Param('projectId') projectId: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: CancelDeliveryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installs.revoke(principal, projectId, milestoneId, dto.reason);
  }

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
