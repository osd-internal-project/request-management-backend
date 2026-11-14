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
  SalesAutomationService,
  SalesMailService,
  SendLeadEmailDto,
  SendQuotationEmailDto,
  SendRequirementRequestDto,
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
    private readonly automation: SalesAutomationService,
  ) {}

  /**
   * A refusal is kept for the Lead/deal page ("why the workflow stopped",
   * 11 พ.ย. 2569) and a success clears the same action's earlier refusals.
   * The caller still gets the refusal itself.
   */
  private async track<T>(
    target: { leadId?: string; opportunityId?: string; quotationId?: string },
    action: string,
    actor: Principal,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      await this.automation.resolve(target, action, actor);
      return result;
    } catch (error) {
      await this.automation.record(target, action, error, actor);
      throw error;
    }
  }

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
    return this.track({ leadId: id }, 'send_lead_email', actor, () =>
      this.mail.sendLeadIntro(
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
          attachProposal: dto.attach_proposal === true,
        },
        actor,
      ),
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

  @Post('emails/:id/assessment')
  @Permissions('integration.crm.email.read', 'integration.crm.lead.read.all')
  @ApiOperation({
    summary: 'ประเมินคำตอบของลูกค้าก่อนออกใบเสนอราคา — requirement ครบหรือยัง',
    description:
      'อ่าน product / จำนวน / คำตอบของคำถามประจำ product (หน้า ชุดรายการของ Product) จากอีเมลขาเข้า ' +
      'รวมกับที่ลูกค้าเคยตอบ แล้วเก็บบน Lead (`intake_data.requirements`) · `outcome`: ' +
      '`ready` ออกใบเสนอราคาได้ · `ask` ยังขาด (`missing`) ให้ส่ง `emails/:id/requirement-request` · ' +
      '`no_solution` product ไม่มีชุดรายการ/ราคามาตรฐาน — พนักงานขายขอราคาจาก Pricing หรือ Solution จาก Pre-Sales · ' +
      '`handover` ถามครบ 2 ครั้งแล้วยังไม่ครบ — พนักงานขายติดต่อเอง (สองอย่างหลังแจ้งเจ้าของ Lead แล้ว)',
  })
  async assess(
    @Param('id') id: string,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    const result = await this.mail.assessReply(id, actor);
    const target = { leadId: result.lead_id };
    if (result.outcome === 'no_solution' || result.outcome === 'handover') {
      // not a refusal to the caller, but the Lead page should say why it stopped
      await this.automation.record(
        target,
        'assess_reply',
        new AppError('CRM_QUOTATION_UNPRICED', result.reason, [
          { field: 'requirements', reason: result.outcome },
        ]),
        actor,
      );
    } else {
      await this.automation.resolve(target, 'assess_reply', actor);
    }
    return result;
  }

  @Post('emails/:id/requirement-request')
  @Permissions('integration.crm.email.send', 'integration.crm.lead.read.all')
  @ApiOperation({
    summary: 'ส่งอีเมลถาม requirement ที่ยังขาด ตอบในเธรดเดิมของลูกค้า',
    description:
      'ถามเฉพาะข้อที่ `assessment` ล่าสุดตอบว่าขาด (`outcome = ask`; อย่างอื่น = 409) · ผู้รับ = ผู้ส่งอีเมลฉบับนั้น · ' +
      'คำตอบของลูกค้ากลับมาเป็น `crm.email.received` (interested) ให้ประเมินใหม่',
  })
  async requestRequirements(
    @Param('id') id: string,
    @Body() dto: SendRequirementRequestDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    const email = await this.mail.findOne(id, actor);
    return this.track(
      { leadId: email.lead_id ?? undefined },
      'send_requirement_email',
      actor,
      () => this.mail.sendRequirementRequest(id, dto, actor),
    );
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
    return this.track(
      { opportunityId: id },
      'create_standard_quotation',
      actor,
      () => this.mail.standardQuotation(id, dto, actor),
    );
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
    return this.track({ quotationId: id }, 'send_quotation_email', actor, () =>
      this.mail.sendQuotation(id, dto, actor),
    );
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
    return this.track({ quotationId: id }, 'accept_quotation', actor, () =>
      this.quotations.accept(id, { note }, actor),
    );
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
