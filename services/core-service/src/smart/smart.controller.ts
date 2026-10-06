import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  DiscardProspectDto,
  ImportProspectsDto,
  ListProspectsQueryDto,
  SaveSmartSourceDto,
} from './smart.dto';
import { SmartService } from './smart.service';

/** CD-289 (CD-16 AI SMART) — sweep sources and the staging list. */
@ApiTags('smart')
@ApiBearerAuth()
@Controller('smart')
export class SmartController {
  constructor(private readonly smart: SmartService) {}

  @ApiOperation({ summary: 'CD-289 แหล่งกวาด Lead ทั้งหมด พร้อมจำนวนที่ได้' })
  @Get('sources')
  @Permissions('smart.prospect.read')
  sources(@CurrentPrincipal() principal: Principal) {
    return this.smart.listSources(principal);
  }

  @ApiOperation({ summary: 'CD-289 เพิ่มแหล่งกวาด Lead' })
  @Post('sources')
  @Permissions('smart.prospect.manage')
  createSource(
    @Body() dto: SaveSmartSourceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.createSource(principal, dto);
  }

  @ApiOperation({ summary: 'CD-289 แก้แหล่งกวาด Lead (เงื่อนไข รอบ เปิด/ปิด)' })
  @Put('sources/:id')
  @Permissions('smart.prospect.manage')
  updateSource(
    @Param('id') id: string,
    @Body() dto: SaveSmartSourceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.updateSource(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-289 กวาดแหล่งนี้เดี๋ยวนี้ (dbd/web/social)' })
  @Post('sources/:id/run')
  @Permissions('smart.prospect.manage')
  run(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.smart.runNow(principal, id);
  }

  @ApiOperation({ summary: 'CD-289 นำเข้ารายชื่อจากไฟล์ (แหล่งชนิด file)' })
  @Post('sources/:id/import')
  @Permissions('smart.prospect.manage')
  import(
    @Param('id') id: string,
    @Body() dto: ImportProspectsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.importRows(principal, id, dto.rows);
  }

  @ApiOperation({ summary: 'CD-289 ประวัติการกวาด (100 รอบล่าสุด)' })
  @Get('runs')
  @Permissions('smart.prospect.read')
  runs(
    @Query('source_id') sourceId: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.listRuns(principal, sourceId);
  }

  @ApiOperation({ summary: 'CD-289 รายชื่อที่กวาดได้ (ยังไม่เข้า CRM)' })
  @Get('prospects')
  @Permissions('smart.prospect.read')
  prospects(
    @Query() query: ListProspectsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.listProspects(principal, query);
  }

  @ApiOperation({
    summary: 'CD-289 รายชื่อที่กวาดได้ หนึ่งรายการ พร้อมหลักฐาน',
  })
  @Get('prospects/:id')
  @Permissions('smart.prospect.read')
  prospect(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.smart.prospect(principal, id);
  }

  @ApiOperation({ summary: 'CD-289 ทิ้งรายชื่อ พร้อมเหตุผล' })
  @Post('prospects/:id/discard')
  @Permissions('smart.prospect.manage')
  discard(
    @Param('id') id: string,
    @Body() dto: DiscardProspectDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.smart.discard(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-289 เปิดรายชื่อที่ทิ้งไปแล้วกลับมา' })
  @Post('prospects/:id/reopen')
  @Permissions('smart.prospect.manage')
  reopen(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.smart.reopen(principal, id);
  }
}
