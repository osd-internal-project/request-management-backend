import { Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Public,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { LineLinkService, type CallbackQuery } from './line-link.service';

/** แจ้งเตือน → LINE — ผู้ใช้ผูก LINE ของตัวเองกับ OA ของบริษัทที่เลือกอยู่. */
@ApiTags('line')
@ApiBearerAuth()
@Controller('notifications/line')
export class LineLinkController {
  constructor(private readonly link: LineLinkService) {}

  @ApiOperation({ summary: 'สถานะการผูก LINE ของฉันในบริษัทนี้' })
  @Get()
  @Authenticated()
  status(@CurrentPrincipal() principal: Principal) {
    return this.link.status(principal);
  }

  @ApiOperation({
    summary: 'เริ่มผูก — คืน URL ของ LINE Login (state อายุ 10 นาที)',
  })
  @Post('start')
  @Authenticated()
  start(@CurrentPrincipal() principal: Principal) {
    return this.link.start(principal);
  }

  @ApiOperation({
    summary: 'LINE ส่งกลับมา (สาธารณะ — ผ่าน /api/public/line/callback ของเว็บ)',
    description:
      'คืน `{ ok }` หรือ `{ ok: false, reason }` เสมอ ไม่ตอบ error — หน้าเว็บ redirect ตาม reason',
  })
  @Get('callback')
  @Public()
  callback(@Query() query: CallbackQuery) {
    return this.link.complete(query);
  }

  @ApiOperation({ summary: 'ยกเลิกการผูก LINE ในบริษัทนี้' })
  @Delete()
  @HttpCode(204)
  @Authenticated()
  unlink(@CurrentPrincipal() principal: Principal) {
    return this.link.unlink(principal);
  }
}
