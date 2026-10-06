import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CampaignLeadIntakeService,
  LeadIntakeService,
  type ApiKeyContext,
  CurrentApiKey,
} from '@request-management/core-service';
import {
  IntakeLeadDto,
  IntakeLeadResultDto,
} from '@request-management/core-service';

/**
 * ประตูที่ระบบภายนอกยิง Lead เข้ามาเอง (14 ก.ย. 2569).
 *
 * **ต่างจาก `/external/*` ตรงที่ไม่มีคนอยู่ปลายสาย.** `/external` สร้างมาให้
 * แชตบอตทำงาน *แทนคน* — มันส่ง `X-Acting-User` มาทุกครั้ง แล้ว `ActingUserGuard`
 * สลับ principal เป็นของคนนั้น. เว็บฟอร์มไม่มีคนแบบนั้นให้ชี้: คนที่กรอกคือ
 * ลูกค้า ไม่ใช่พนักงานของเรา. ใบที่เข้ามาทางนี้จึง **ไม่มีเจ้าของ** และไปรออยู่
 * กองกลางจนกว่าจะมีคนกด `PATCH /leads/{id}/owner`.
 *
 * **แยกจาก `LeadWorkflowController` ทั้งที่ prefix เดียวกัน** ด้วยเหตุผลที่
 * ไฟล์นั้นเขียนไว้: คนละผู้เรียก คนละสิทธิ์ คนละสัญญา. `integration.crm.lead.read`
 * / `.stage` เป็นของ workflow engine ส่วน `integration.crm.lead.create` เป็นของ
 * ช่องทางรับ Lead — รวมไว้ controller เดียวเมื่อไร วันหนึ่งเว็บฟอร์มจะเลื่อนขั้น
 * Lead ได้.
 *
 * **API key อย่างเดียว ไม่มี header อื่น.** ส่ง `Authorization: Bearer rfk_…`
 * เท่านั้น — กุญแจหนึ่งใบต่อหนึ่งช่องทาง และตัวกุญแจเองรู้ว่าเป็นของบริษัทไหน
 * ช่องทางอะไร ทำอะไรได้บ้าง (`companyId` / `sourceCode` / `scopes` บน `api_keys`).
 *
 * สามอย่างนั้นจึงไม่ใช่ของที่ผู้เรียกกรอก: เว็บฟอร์มที่รันอยู่บนเซิร์ฟเวอร์คนอื่น
 * ไม่ควรมีสิทธิ์ตัดสินว่า Lead ของตัวเองจะเข้าบริษัทไหน และไม่ควรประกาศตัวเองว่า
 * มาจากช่องทางไหนได้ตามใจ. ส่ง `X-Company-Id` ที่ขัดกับกุญแจมา = ถูกปฏิเสธ.
 *
 * ออกกุญแจของช่องทางใหม่จากหน้าจอ **ผู้ดูแลระบบ → API Key ช่องทางภายนอก**
 * (`admin.integration.manage`) — ตั้งชื่อ, ใส่รหัสช่องทาง, ติ๊กสิทธิ์, กดออก แล้ว
 * คัดลอกค่าเต็มส่งให้ผู้ดูแลช่องทาง (แสดงครั้งเดียว). CLI `yarn apikey:issue`
 * ยังอยู่ สำหรับกุญแจที่ไม่ผูกบริษัทเดียว เช่นของแชตบอตที่ทำงานข้ามบริษัท.
 */
@ApiTags('crm-intake')
@ApiBearerAuth()
@ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description:
    'ควรส่งทุกครั้ง — หนึ่งค่าต่อหนึ่งใบ ' +
    'ยิงซ้ำด้วยค่าเดิมและ body เดิมจะได้ใบเดิมกลับไป ไม่เกิดใบที่สอง ' +
    'ไม่ส่งก็ทำงานได้ แต่ response ที่หายกลางทางแล้ว retry จะกลายเป็น Lead สองใบ',
  schema: { type: 'string', example: '6f6bd3a7-7308-4d2e-a4de-75e1f89b6871' },
})
@Controller('crm/leads')
@ServiceAccountOnly()
export class ExternalLeadIntakeController {
  constructor(
    private readonly intake: LeadIntakeService,
    // CD-269 — a campaign's public form and Lead Ads
    private readonly campaignIntake: CampaignLeadIntakeService,
  ) {}

  /*
    `intake` ต่อท้าย ไม่ใช่ `POST crm/leads` เปล่า ๆ (21 ก.ย. 2569).

    เดิมทั้งคอนโทรลเลอร์นี้และ `ExternalLeadsController.create` ผูก `POST crm/leads`
    เส้นเดียวกัน และ `ExternalLeadsController` ถูก register ก่อนใน `crm.module.ts`
    Express จึงจับตัวนั้นเสมอ — **เส้นนี้เรียกไม่ถึงเลย** เว็บฟอร์มที่ยิงมาด้วยกุญแจ
    อย่างเดียวตามที่เอกสารบอก ได้ 400 `ต้องระบุ header x-acting-user` ไม่ใช่ Lead

    แยก path แทนการสลับลำดับ register เพราะการสลับจะทำให้ `create` ตายแทน — สองเส้นนี้
    รับคนละ DTO และคนละประตู อยู่ร่วม path เดียวกันไม่ได้ตั้งแต่ต้น ชื่อ `intake`
    ตรงกับ `POST request/intake` ที่ฝั่งคำขอใช้อยู่แล้วสำหรับความหมายเดียวกัน
  */
  @Post('intake')
  @Permissions('integration.crm.lead.create')
  @ApiOperation({
    summary: 'รับ Lead จากระบบภายนอก — เข้ากองกลาง รอพนักงานขายรับ',
    description:
      'ต้องมีแค่ `Authorization: Bearer rfk_…` — บริษัทและช่องทางมาจากตัว API key ' +
      'ไม่ต้องส่ง `X-Company-Id` และไม่ต้องส่ง `source_code`\n\n' +
      'ใบที่สร้างจะไม่มีเจ้าของ (`owner_user_id: null`) และแสดงในหน้ารายการของ ' +
      'ทุกคนที่อ่าน Lead ได้ในบริษัทนั้น จนกว่าจะมีคนกด ' +
      '`PATCH /leads/{id}/owner` เพื่อรับไปดูแล ' +
      'ขั้นตั้งต้นและ workflow เดินเหมือนกับ Lead ที่พนักงานกรอกเองทุกประการ',
  })
  @ApiCreatedResponse({
    description: 'Lead ที่รับเข้ากองกลางแล้ว',
    type: IntakeLeadResultDto,
  })
  receive(
    @Body() dto: IntakeLeadDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.intake.receive(dto, principal, key);
  }

  /*
    CD-269 — a campaign's public form (/f/lead/<token>). The web app's server
    calls these with its own intake key; the person filling the form never
    holds a key. The token picks the campaign (and so the company): a key bound
    to another company is answered 404, as is a form switched off.
  */
  @Get('forms/:token')
  @Permissions('integration.crm.lead.create')
  @ApiOperation({
    summary: 'CD-269 หัวฟอร์มสาธารณะของแคมเปญ (ชื่อแคมเปญ + ข้อความแนะนำ)',
  })
  form(
    @Param('token') token: string,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.campaignIntake.formOf(token, key);
  }

  @Post('forms/:token')
  @Permissions('integration.crm.lead.create')
  @ApiOperation({
    summary: 'CD-269 ส่งฟอร์มสาธารณะของแคมเปญ — คัดกรองเหมือน intake',
    description:
      'คนเดิมภายใน 30 วันไปต่อท้าย Lead ที่ยังเปิด · ลูกค้าเดิมส่งถึงผู้ดูแลลูกค้า · ' +
      'ใบใหม่เข้ากองของทีมที่รับของแคมเปญ. ตอบแค่ว่ารับแล้ว ไม่เปิดข้อมูล Lead',
  })
  submitForm(
    @Param('token') token: string,
    @Body() dto: IntakeLeadDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.campaignIntake.submitForm(token, dto, principal, key);
  }

  @Post('ads/:platform')
  @Permissions('integration.crm.lead.create')
  @ApiOperation({
    summary: 'CD-269 Lead Ads (facebook | tiktok) — ตัวแปลงข้อมูลฟอร์มโฆษณา',
    description:
      'รับคำตอบหนึ่งชุดในรูปแบบของแพลตฟอร์ม (Facebook `field_data`, TikTok `user_info`/`answers`) ' +
      'พร้อม `form_id` — form_id เลือกแคมเปญจาก `ad_form_ids` ของแคมเปญ. ' +
      'ยังเป็นโหมด mock: ผู้ส่งต้องดึงข้อมูล Lead มาเอง (เช่น ตัวเชื่อม/Zapier) ' +
      'ส่วนการรับ webhook ตรงจากแพลตฟอร์มรอบัญชีโฆษณาและ app review',
  })
  receiveAd(
    @Param('platform') platform: string,
    @Body() payload: Record<string, unknown>,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.campaignIntake.receiveAd(platform, payload, principal, key);
  }
}
