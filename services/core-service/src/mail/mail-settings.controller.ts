import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  TestMailSettingsDto,
  UpdateMailSettingsDto,
} from './dto/mail-settings.dto';
import { MailSettingsService } from './mail-settings.service';

/** ตั้งค่า → อีเมลงานขาย — mailbox + App ของ Microsoft Graph ต่อบริษัท. */
@ApiTags('mail-settings')
@ApiBearerAuth()
@Controller('admin/mail-settings')
export class MailSettingsController {
  constructor(private readonly settings: MailSettingsService) {}

  @ApiOperation({
    summary: 'ค่าที่ใช้อยู่ของบริษัทนี้ (secret ไม่แสดงกลับ)',
    description:
      '`source` = company (ตั้งบนหน้าจอ) หรือ env (ยังไม่เคยตั้ง ใช้ MAIL_*)',
  })
  @Get()
  @Permissions('admin.integration.manage')
  get(@CurrentPrincipal() principal: Principal) {
    return this.settings.get(principal);
  }

  @ApiOperation({ summary: 'บันทึก — client secret ว่าง = ใช้ค่าเดิม' })
  @Put()
  @Permissions('admin.integration.manage')
  update(
    @Body() dto: UpdateMailSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.settings.update(dto, principal);
  }

  @ApiOperation({
    summary: 'ส่งอีเมลทดสอบด้วยค่าที่กรอก (ยังไม่ต้องบันทึก)',
    description:
      'ผู้รับตั้งต้น = อีเมลของผู้กด · ผลล่าสุดเก็บไว้ถ้าบันทึกค่าแล้ว',
  })
  @Post('test')
  @Permissions('admin.integration.manage')
  test(
    @Body() dto: TestMailSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.settings.test(dto, principal);
  }
}
