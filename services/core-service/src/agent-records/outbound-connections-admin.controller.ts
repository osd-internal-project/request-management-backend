import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { AgentAction } from './agent-actions';
import { OutboundConnectionsAdminService } from './outbound-connections-admin.service';
import {
  AgentActionInfoDto,
  ConnectionTestResultDto,
  CreateOutboundConnectionDto,
  ListOutboundConnectionsDto,
  OutboundConnectionKeyDto,
  OutboundConnectionRowDto,
  TestOutboundConnectionDto,
  UpdateOutboundConnectionDto,
} from './dto/outbound-connection.dto';

/** ผู้ดูแลตั้งการเชื่อมต่อที่ CTD ใช้ส่งงานของ agent — แท็บในหน้า Integrations. */
@ApiTags('admin/outbound-connections')
@ApiBearerAuth()
@Controller('admin/outbound-connections')
export class OutboundConnectionsAdminController {
  constructor(private readonly connections: OutboundConnectionsAdminService) {}

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'การเชื่อมต่อของระบบภายนอกหนึ่งระบบ — ไม่มี key ในคำตอบ',
  })
  @ApiOkResponse({ type: [OutboundConnectionRowDto] })
  list(
    @Query() query: ListOutboundConnectionsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.connections.list(query.integration_id, principal);
  }

  /** ประกาศก่อน `:id` ไม่งั้น `actions` จะถูกอ่านเป็น id. */
  @Get('actions')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'งานที่ส่งให้ agent ได้ — vendor, ข้อมูลที่ส่ง, timeout เริ่มต้น',
  })
  @ApiOkResponse({ type: [AgentActionInfoDto] })
  actions() {
    return this.connections.actions();
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'เพิ่มการเชื่อมต่อ — vendor ละหนึ่งแถวต่อบริษัท' })
  @ApiCreatedResponse({ type: OutboundConnectionRowDto })
  create(
    @Body() dto: CreateOutboundConnectionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.connections.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'แก้ URL, key, เปิด/ปิด หรือ endpoint ของงาน (ส่งทั้งชุด)',
  })
  @ApiOkResponse({ type: OutboundConnectionRowDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOutboundConnectionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.connections.update(id, dto, principal);
  }

  @Get(':id/key')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'ดู x-api-key ปัจจุบัน — ทุกครั้งที่ดูลง audit' })
  @ApiOkResponse({ type: OutboundConnectionKeyDto })
  revealKey(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.connections.revealKey(id, principal);
  }

  @Post(':id/test')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'ทดสอบการเชื่อมต่อด้วยการเรียกจริง (`connection_test: true`)',
  })
  @ApiOkResponse({ type: ConnectionTestResultDto })
  test(
    @Param('id') id: string,
    @Body() dto: TestOutboundConnectionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    // `@IsIn(ACTIONS)` on the DTO already narrowed it
    return this.connections.test(id, dto.action as AgentAction, principal);
  }
}
