import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { WorkflowTriggerAdminService } from './workflow-trigger-admin.service';
import {
  CreateWorkflowTriggerDto,
  UpdateWorkflowTriggerDto,
  WorkflowStartRowDto,
  WorkflowTriggerEventDto,
  WorkflowTriggerRowDto,
} from './dto/workflow-trigger.dto';

/** ผู้ดูแลตั้งว่าเหตุการณ์ไหนใน CTD เริ่ม workflow ไหนบน OSD Workflow (22 ต.ค. 2569). */
@ApiTags('admin/workflow-triggers')
@ApiBearerAuth()
@Controller('admin/workflow-triggers')
export class WorkflowTriggerAdminController {
  constructor(private readonly triggers: WorkflowTriggerAdminService) {}

  @Get('events')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary: 'เหตุการณ์ที่เริ่ม workflow ได้ และตัวแปรที่แต่ละเหตุการณ์ส่ง',
  })
  @ApiOkResponse({ type: [WorkflowTriggerEventDto] })
  events() {
    return this.triggers.events();
  }

  @Get()
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'รายการของบริษัทนี้ — ไม่มี channel key ในคำตอบ' })
  @ApiOkResponse({ type: [WorkflowTriggerRowDto] })
  list(@CurrentPrincipal() principal: Principal) {
    return this.triggers.list(principal);
  }

  @Post()
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'เพิ่ม: เหตุการณ์ → channel ของ workflow' })
  @ApiCreatedResponse({ type: WorkflowTriggerRowDto })
  create(
    @Body() dto: CreateWorkflowTriggerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.triggers.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'แก้ เปิด/ปิด หรือเปลี่ยน channel key' })
  @ApiOkResponse({ type: WorkflowTriggerRowDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowTriggerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.triggers.update(id, dto, principal);
  }

  @Get(':id/starts')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'การเริ่ม workflow 50 รายการล่าสุด' })
  @ApiOkResponse({ type: [WorkflowStartRowDto] })
  starts(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.triggers.listStarts(id, principal);
  }

  @Post(':id/starts/:startId/retry')
  @Permissions('admin.integration.manage')
  @ApiOperation({ summary: 'นำรายการที่ล้ม (dead) กลับเข้าคิว' })
  @ApiCreatedResponse({ type: WorkflowStartRowDto })
  retry(
    @Param('id') id: string,
    @Param('startId') startId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.triggers.retry(id, startId, principal);
  }

  @Post(':id/test')
  @Permissions('admin.integration.manage')
  @ApiOperation({
    summary:
      'เริ่ม workflow จริง 1 ครั้งด้วยตัวแปรตัวอย่าง (OSD Workflow ไม่มี dry run)',
  })
  @ApiCreatedResponse({ type: WorkflowStartRowDto })
  test(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.triggers.test(id, principal);
  }
}
