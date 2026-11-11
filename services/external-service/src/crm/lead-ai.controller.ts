import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AppError,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ConvertLeadDto,
  CurrentApiKey,
  LEAD_FILE_BODY,
  LEAD_FILE_UPLOAD,
  LeadFilesService,
  LeadsService,
  SalesAutomationService,
  UpdateLeadDto,
  UpdateLeadIntakeDataDto,
  type ApiKeyContext,
} from '@request-management/core-service';

/** Personal data on a lead — returned only to a key holding `contact.read`. */
const CONTACT_FIELDS = [
  'email',
  'phone',
  'contactName',
  'contactPosition',
] as const;

/**
 * AI agent ที่ทำงานแทน *บริษัท* ไม่ใช่แทนคน (22 ต.ค. 2569) — ไม่มี
 * `X-Acting-User`: ขอบเขตแถวคือบริษัทของ key (`readsAllLeads` ใน
 * `visibleLeadsWhere`), ความสามารถคือ scope ต่อ use case บน key.
 *
 * เรียก `LeadsService` ตัวเดียวกับหน้าจอ — audit, event, workflow และด่าน
 * "Lead ยังเปิดอยู่" จึงเหมือนทุกทางเข้า. path แยก (`crm/ai/leads`) เพราะ
 * `ExternalLeadsController` ถือ `crm/leads/:id` ด้วย METHOD เดียวกันอยู่แล้ว
 * — สอง handler บนเส้นเดียวคือบั๊ก `intake` (21 ก.ย. 2569).
 *
 * สร้าง Lead = `POST crm/leads/intake`, เปลี่ยนสถานะ = `POST crm/leads/:id/stage`
 * มีอยู่แล้วและไม่ต้องมีคนเหมือนกัน — ไม่ทำซ้ำที่นี่.
 */
@ApiTags('crm-ai')
@ApiBearerAuth()
@Controller('crm/ai/leads')
@ActsAsCompany()
export class ExternalLeadAiController {
  constructor(
    private readonly leads: LeadsService,
    private readonly files: LeadFilesService,
    private readonly automation: SalesAutomationService,
  ) {}

  @Get(':id')
  @Permissions('integration.crm.lead.read.all')
  @ApiOperation({
    summary: 'อ่าน Lead (ทั้งบริษัทของ key) — อีเมล/เบอร์ ต้องมี contact.read',
    description:
      '`email` `phone` `contactName` `contactPosition` เป็น null ถ้า key ไม่มี ' +
      '`integration.crm.lead.contact.read`',
  })
  async findOne(
    @Param('id') id: string,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    const lead = (await this.leads.findOne(id, actor)) as Record<
      string,
      unknown
    >;
    if (actor.permissions.includes('integration.crm.lead.contact.read')) {
      return lead;
    }
    return {
      ...lead,
      ...Object.fromEntries(CONTACT_FIELDS.map((field) => [field, null])),
    };
  }

  @Patch(':id')
  @Permissions('integration.crm.lead.update')
  @ApiOperation({ summary: 'แก้ข้อมูล Lead — ส่งเฉพาะ field ที่เปลี่ยน' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.leads.update(id, dto, actor);
  }

  @Patch(':id/intake-data')
  @Permissions('integration.crm.lead.update')
  @ApiOperation({
    summary: 'แก้ข้อมูล intake (JSON) — merge ทีละ key, null = ลบ key',
  })
  updateIntakeData(
    @Param('id') id: string,
    @Body() dto: UpdateLeadIntakeDataDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.leads.updateIntakeData(id, dto, actor);
  }

  @Get(':id/files')
  @Permissions('integration.crm.lead.read.all')
  @ApiOperation({ summary: 'ไฟล์บน Lead (ล่าสุดก่อน)' })
  listFiles(
    @Param('id') id: string,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.files.list(id, actor);
  }

  @Post(':id/files')
  @Permissions('integration.crm.lead.update')
  @ApiOperation({
    summary: 'วางไฟล์บน Lead (PDF/Word/PowerPoint/Excel/รูป ≤ 20 MB)',
    description:
      'kind=proposal = ไฟล์ที่อีเมลขอบคุณแนบไป (`POST crm/ai/leads/:id/emails` attach_proposal) — ใช้ฉบับล่าสุด',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(LEAD_FILE_BODY)
  @UseInterceptors(LEAD_FILE_UPLOAD)
  uploadFile(
    @Param('id') id: string,
    @Body('kind') kind: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    return this.files.upload(id, kind, file, actor);
  }

  @Post(':id/convert')
  @Permissions('integration.crm.lead.convert')
  @ApiOperation({
    summary: 'แปลง Lead เป็นโอกาสการขาย — ไปอยู่กับเจ้าของ Lead',
    description: 'Lead ในกองกลาง (ยังไม่มีเจ้าของ) ตอบ 409 — มอบหมายก่อน',
  })
  async convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentPrincipal() actor: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    requireCompanyKey(key);
    // why the sales workflow stopped shows on the Lead page (11 พ.ย. 2569)
    try {
      const deal = await this.leads.convert(id, dto, actor);
      await this.automation.resolve({ leadId: id }, 'convert_lead', actor);
      return deal;
    } catch (error) {
      await this.automation.record(
        { leadId: id },
        'convert_lead',
        error,
        actor,
      );
      throw error;
    }
  }
}

/**
 * "The whole company" needs one company: an unbound key (the chatbot's)
 * picks it from a header, which would let it read any company's leads.
 */
function requireCompanyKey(key: ApiKeyContext | undefined): void {
  if (!key?.companyId) {
    throw new AppError(
      'FORBIDDEN',
      'route ของ AI ต้องใช้ API key ที่ผูกบริษัท',
      [{ field: 'authorization', reason: 'company-bound api key required' }],
    );
  }
}
