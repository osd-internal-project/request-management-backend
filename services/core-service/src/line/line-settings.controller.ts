import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { UpdateLineSettingsDto } from './dto/line-settings.dto';
import { LineSettingsService } from './line-settings.service';

/** ตั้งค่า → LINE — LINE Login channel ของบริษัท ใช้ให้แต่ละคนผูก LINE กับ OA. */
@ApiTags('line-settings')
@ApiBearerAuth()
@Controller('admin/line-settings')
export class LineSettingsController {
  constructor(private readonly settings: LineSettingsService) {}

  @ApiOperation({
    summary: 'ค่าที่ใช้อยู่ของบริษัทนี้ (secret ไม่แสดงกลับ)',
    description: '`callback_url` คือค่าที่ต้องใส่ใน LINE Developers ของ channel',
  })
  @Get()
  @Permissions('admin.integration.manage')
  get(@CurrentPrincipal() principal: Principal) {
    return this.settings.get(principal);
  }

  @ApiOperation({ summary: 'บันทึก — channel secret ว่าง = ใช้ค่าเดิม' })
  @Put()
  @Permissions('admin.integration.manage')
  update(
    @Body() dto: UpdateLineSettingsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.settings.update(dto, principal);
  }
}
