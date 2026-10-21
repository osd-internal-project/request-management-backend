import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ProcessLogPageDto, ProcessLogQueryDto } from './dto/process-log.dto';
import { PROCESS_STAGES } from './process-stages';
import { ProcessLogService } from './process-log.service';

/** หน้าบันทึกกระบวนการ 7 ขั้น — อ่านอย่างเดียว ไม่มีเส้นแก้/ลบ. */
@ApiTags('process-logs')
@ApiBearerAuth()
@Controller('process-logs')
export class ProcessLogController {
  constructor(private readonly logs: ProcessLogService) {}

  @Get('stages')
  @Permissions('audit.read')
  @ApiOperation({ summary: 'ขั้นทั้ง 7 ของกระบวนการ End-to-End' })
  stages() {
    return PROCESS_STAGES;
  }

  @Get()
  @Permissions('audit.read')
  @ApiOperation({ summary: 'บันทึกการเดินของกระบวนการ — ใหม่สุดก่อน' })
  @ApiOkResponse({ type: ProcessLogPageDto })
  list(
    @Query() query: ProcessLogQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.logs.list(query, principal.activeCompanyId);
  }
}
