import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { AGENT_ACTIONS } from './agent-actions';
import { AgentRecordsService } from './agent-records.service';
import {
  FindLeadsDto,
  ListAgentRecordsDto,
  StreamAgentRecordsDto,
} from './dto/agent-record.dto';

/**
 * อ่านงานของ agent — `@Authenticated()` แล้วกรองใน service ตามสิทธิ์ `read`
 * ของแต่ละ action (`AGENT_ACTIONS`) เพราะสิทธิ์ต่างกันตามแถว ไม่ใช่ตาม route.
 */
@ApiTags('agent-records')
@ApiBearerAuth()
@Controller('agent-records')
export class AgentRecordsController {
  constructor(private readonly records: AgentRecordsService) {}

  @ApiOperation({ summary: 'รายการงานของ agent (เฉพาะ action ที่มีสิทธิ์ดู)' })
  @Get()
  @Authenticated()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListAgentRecordsDto,
  ) {
    return this.records.list(principal, query);
  }

  /** ประกาศก่อน `:id` ไม่งั้น `stream` จะถูกอ่านเป็น id. */
  @ApiOperation({
    summary: 'เฝ้าสถานะงานแบบ SSE',
    description:
      'event `record` เมื่อแถวเปลี่ยน, `ping` ทุก 15 วิ; ปิดเองเมื่อทุกแถวจบหรือครบ 15 นาที',
  })
  @Sse('stream')
  @Authenticated()
  @Header('Cache-Control', 'no-cache')
  @Header('X-Accel-Buffering', 'no')
  stream(
    @CurrentPrincipal() principal: Principal,
    @Query() query: StreamAgentRecordsDto,
  ) {
    return this.records.watch(query.ids, principal);
  }

  @ApiOperation({ summary: 'รายละเอียดงานของ agent พร้อมผลลัพธ์' })
  @Get(':id')
  @Authenticated()
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.records.findOne(id, principal);
  }
}

/** สั่ง agent หา Lead — อยู่ใต้ `leads/` เพราะเป็นปุ่มของหน้า Lead. */
@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadFindController {
  constructor(private readonly records: AgentRecordsService) {}

  @ApiOperation({
    summary: 'ให้ agent หา Lead ตามหัวข้อ',
    description: 'สร้างงาน `lead.find` แล้วส่งให้ Vuvagent — ตอบ record ทันที',
  })
  @Post('find')
  @Permissions(AGENT_ACTIONS['lead.find'].start)
  find(@Body() dto: FindLeadsDto, @CurrentPrincipal() principal: Principal) {
    return this.records.findLeads(dto, principal);
  }
}
