import { Body, Controller, Post } from '@nestjs/common';
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
  constructor(private readonly intake: LeadIntakeService) {}

  @Post()
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
}
