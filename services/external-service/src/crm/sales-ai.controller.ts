import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AcceptQuotationByEmailDto,
  CreateStandardQuotationDto,
  CurrentApiKey,
  QuotationsService,
  SalesMailService,
  SendLeadEmailDto,
  SendQuotationEmailDto,
  type ApiKeyContext,
} from '@request-management/core-service';
import { ActsAsCompany } from '../auth/acts-as-company.decorator';

/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569, ผู้ใช้ตัดสิน) — OSD Workflow / AI ในนามบริษัท
 * เดินงานขายจาก Lead ถึงลูกค้ายืนยัน: ส่งอีเมลขอบคุณ+proposal → (ลูกค้าตอบ →
 * event `crm.email.received` พร้อมผลจัดประเภท) → ใบเสนอราคาจากราคามาตรฐาน →
 * ส่ง PDF ตอบในเธรดเดิม → บันทึกว่าลูกค้ายืนยัน/ออก PO.
 *
 * ไม่มีคนปลายทาง (`@ActsAsCompany`): ขอบเขตคือบริษัทของ key, ดีลและใบเสนอราคา
 * ยังเป็นของเจ้าของ Lead เสมอ, ผู้รับอีเมลคืออีเมลบน Lead/ดีลเท่านั้น (ผู้เรียก
 * กำหนดผู้รับเองไม่ได้). AGENTS.md "The eleventh".
 */
@ApiTags('crm-ai')
@ApiBearerAuth()
@Controller('crm/ai')
@ActsAsCompany()
export class ExternalSalesAiController {
  constructor(
    private readonly mail: SalesMailService,
    private readonly quotations: QuotationsService,
  ) {}

  @Post('leads/:id/emails')
  @Permissions('integration.crm.email.send', 'integration.crm.lead.read.all')
  @ApiOperation({
    summary: 'ส่งอีเมลขอบคุณ (+ proposal) ถึงผู้ติดต่อของ Lead',
    description:
      'ผู้รับ = อีเมลบน Lead · ส่งจาก mailbox ของบริษัท (MAIL_MAILBOX) · คำตอบของลูกค้าในเธรดนี้กลายเป็น event `crm.email.received`',
  })
  sendLeadEmail(
    @Param('id') id: string,
    @Body() dto: SendLeadEmailDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.mail.sendLeadIntro(
      id,
      {
        subject: dto.subject,
        body: dto.body,
        signature: dto.signature,
        attachments: (dto.attachments ?? []).map((file) => ({
          name: file.file_name,
          contentType: file.content_type,
          contentBase64: file.content_base64,
        })),
      },
      actor,
    );
  }

  @Get('emails/:id')
  @Permissions('integration.crm.email.read', 'integration.crm.lead.read.all')
  @ApiOperation({
    summary: 'อ่านอีเมลหนึ่งฉบับ — ผลจัดประเภท (intent) และข้อความ',
  })
  findEmail(
    @Param('id') id: string,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.mail.findOne(id, actor);
  }

  @Post('opportunities/:id/quotations')
  @Permissions(
    'integration.crm.quotation.create',
    'integration.crm.sales.read.all',
  )
  @ApiOperation({
    summary: 'ร่าง + ยื่นใบเสนอราคาจากราคามาตรฐาน',
    description:
      '`items` ว่าง = ใช้สินค้าบน Lead (`intake_data.products` หรือ `subProduct`). ราคามาตรฐานล้วนได้ `approved` ทันที (ตั้งค่า CRM) · สินค้าไม่มีราคามาตรฐาน = 422 `CRM_QUOTATION_UNPRICED` (ส่งงานให้พนักงานขาย)',
  })
  createQuotation(
    @Param('id') id: string,
    @Body() dto: CreateStandardQuotationDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.mail.standardQuotation(id, dto, actor);
  }

  @Post('quotations/:id/email')
  @Permissions('integration.crm.email.send', 'integration.crm.sales.read.all')
  @ApiOperation({
    summary:
      'ส่งใบเสนอราคา (PDF) ให้ลูกค้าในเธรดเดิม แล้วเปลี่ยนเป็น "ส่งแล้ว"',
    description:
      'เฉพาะใบที่ `approved` · ผู้รับ = อีเมลผู้มุ่งหวังบนดีล หรือของ Lead',
  })
  sendQuotation(
    @Param('id') id: string,
    @Body() dto: SendQuotationEmailDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.mail.sendQuotation(id, dto, actor);
  }

  @Post('quotations/:id/accept')
  @Permissions(
    'integration.crm.quotation.accept',
    'integration.crm.sales.read.all',
  )
  @ApiOperation({
    summary: 'บันทึกว่าลูกค้ายืนยันใบเสนอราคา / ออก PO — งานของเซลล์จบที่นี่',
    description:
      'เฉพาะใบที่ `sent` · เลข PO และอีเมลอ้างอิงเก็บในหมายเหตุการตอบรับ',
  })
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptQuotationByEmailDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    const note = [
      dto.po_no ? `PO ${dto.po_no.trim()}` : 'ลูกค้ายืนยันทางอีเมล',
      dto.email_id ? `อีเมล ${dto.email_id}` : null,
      dto.note?.trim() || null,
    ]
      .filter(Boolean)
      .join(' · ');
    return this.quotations.accept(id, { note }, actor);
  }
}

function requireCompanyKey(key: ApiKeyContext | undefined): void {
  if (!key?.companyId) {
    throw new AppError(
      'FORBIDDEN',
      'route ของ AI ต้องใช้ API key ที่ผูกบริษัท',
      [{ field: 'authorization', reason: 'company-bound api key required' }],
    );
  }
}
