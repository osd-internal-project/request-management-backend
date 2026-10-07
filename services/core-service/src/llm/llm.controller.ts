import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { LlmAdminService } from './llm-admin.service';
import {
  LlmTestDto,
  LlmUsageQueryDto,
  SaveLlmPricesDto,
  UpdateLlmTaskDto,
} from './llm.dto';

/** CD-275 — the LLM Gateway's settings and usage (admins). */
@ApiTags('llm')
@ApiBearerAuth()
@Controller('llm')
export class LlmController {
  constructor(private readonly admin: LlmAdminService) {}

  @ApiOperation({
    summary: 'CD-275 งาน AI ทุกงาน: โมเดล โควตา การใช้เดือนนี้ + ราคาโมเดล',
  })
  @Get('settings')
  @Permissions('admin.llm.manage')
  settings(@CurrentPrincipal() principal: Principal) {
    return this.admin.view(principal);
  }

  @ApiOperation({
    summary: 'CD-275 ตั้งโมเดล/โควตา/เปิดปิด ของงาน AI หนึ่งงาน',
  })
  @Put('tasks/:task')
  @Permissions('admin.llm.manage')
  updateTask(
    @Param('task') task: string,
    @Body() dto: UpdateLlmTaskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateTask(principal, task, dto);
  }

  @ApiOperation({
    summary: 'CD-275 ราคาโมเดล (ทั้งชุด) สำหรับประมาณค่าใช้จ่าย',
  })
  @Put('prices')
  @Permissions('admin.llm.manage')
  savePrices(
    @Body() dto: SaveLlmPricesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.savePrices(principal, dto);
  }

  @ApiOperation({
    summary: 'CD-275 การใช้งานรายเดือน: รวม รายงาน รายโมเดล รายคน ล่าสุด',
  })
  @Get('usage')
  @Permissions('admin.llm.manage')
  usage(
    @Query() query: LlmUsageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.usage(principal, query.month);
  }

  @ApiOperation({
    summary: 'CD-275 ทดลองเรียกโมเดลผ่าน Gateway (นับโควตาของงาน admin.test)',
  })
  @Post('test')
  @Permissions('admin.llm.manage')
  test(@Body() dto: LlmTestDto, @CurrentPrincipal() principal: Principal) {
    return this.admin.test(principal, dto.prompt);
  }
}
