import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { DataLakeService } from './data-lake.service';

/** CD-90 — the Data Lake feed, administered beside the BI dashboards. */
@ApiTags('admin/bi')
@ApiBearerAuth()
@Controller('admin/bi/lake')
export class LakeController {
  constructor(private readonly lake: DataLakeService) {}

  @ApiOperation({
    summary: 'สถานะท่อข้อมูลลง Data Lake ต่อตาราง',
    description:
      '`configured` = ตั้ง LAKE_DATABASE_URL แล้ว · ต่อตาราง: ส่งถึงเวลาใด (watermark), รอบล่าสุด, จำนวนแถวสะสม, คอลัมน์ที่ไม่ส่ง',
  })
  @Get()
  @Permissions('admin.bi.manage')
  status() {
    return this.lake.status();
  }

  @ApiOperation({ summary: 'ส่งข้อมูลที่เปลี่ยนลง Data Lake ตอนนี้' })
  @Post('run')
  @Permissions('admin.bi.manage')
  @HttpCode(200)
  run(@CurrentPrincipal() principal: Principal) {
    return this.lake.runNow(principal);
  }
}
