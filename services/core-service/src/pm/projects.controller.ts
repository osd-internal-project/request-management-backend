import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AchieveMilestoneDto,
  ListProjectsQueryDto,
  OpenProjectDto,
  SaveMilestoneDto,
  PlanPreviewDto,
  SavePredecessorsDto,
  SaveTaskDto,
  SaveProjectMembersDto,
  TickCriterionDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { MAX_EVIDENCE_BYTES, MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { ProjectsService } from './projects.service';

/**
 * CD-18 PM โครงการ. Reading a project asks only for a signed-in person
 * (`notification.read`, which every role holds) because its manager and
 * team see it without `pm.project.read`; the service decides which rows.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly milestones: MilestonesService,
    private readonly plan: PlanService,
  ) {}

  @ApiOperation({ summary: 'รายการโครงการ (ทั้งบริษัท หรือของฉัน)' })
  @Get()
  @Permissions('notification.read')
  list(
    @Query() query: ListProjectsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.list(principal, query);
  }

  @ApiOperation({ summary: 'สัญญาที่ลงนามแล้วและยังไม่ได้เปิดโครงการ' })
  @Get('openable-contracts')
  @Permissions('pm.project.manage')
  openable(@CurrentPrincipal() principal: Principal) {
    return this.projects.openable(principal);
  }

  @ApiOperation({
    summary: 'ตรวจก่อนเปิดโครงการ — ข้อมูลที่จะดึงมา และสิ่งที่ยังขาด',
  })
  @Get('preview/:contractId')
  @Permissions('pm.project.manage')
  preview(
    @Param('contractId') contractId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.preview(contractId, principal);
  }

  @ApiOperation({ summary: 'โครงการที่เปิดจากสัญญานี้' })
  @Get('by-contract/:contractId')
  @Permissions('notification.read')
  forContract(
    @Param('contractId') contractId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.forContract(contractId, principal);
  }

  @ApiOperation({ summary: 'เปิดโครงการจากสัญญาที่ลงนามแล้ว' })
  @Post()
  @Permissions('pm.project.manage')
  open(@Body() dto: OpenProjectDto, @CurrentPrincipal() principal: Principal) {
    return this.projects.open(dto, principal);
  }

  @ApiOperation({ summary: 'รายละเอียดโครงการ' })
  @Get(':id')
  @Permissions('notification.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.projects.detail(id, principal);
  }

  @ApiOperation({ summary: 'แก้ชื่อ ผู้จัดการ หรือพัก/ดำเนินการต่อ' })
  @Patch(':id')
  @Permissions('pm.project.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.update(id, dto, principal);
  }

  @ApiOperation({
    summary: 'จัดทีมโครงการ (ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการ)',
  })
  @Put(':id/members')
  @Permissions('notification.read')
  saveMembers(
    @Param('id') id: string,
    @Body() dto: SaveProjectMembersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projects.saveMembers(id, dto, principal);
  }

  // --- CD-182 milestones ------------------------------------------------------------

  @ApiOperation({ summary: 'หมุดหมายของโครงการ และงวดชำระของสัญญา' })
  @Get(':id/milestones')
  @Permissions('notification.read')
  listMilestones(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.list(id, principal);
  }

  @ApiOperation({
    summary: 'เพิ่มหมุดหมาย (ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการ)',
  })
  @Post(':id/milestones')
  @Permissions('notification.read')
  createMilestone(
    @Param('id') id: string,
    @Body() dto: SaveMilestoneDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'สร้างหมุดหมายจากงวดวางบิลที่ยังไม่ผูก' })
  @Post(':id/milestones/from-schedule')
  @Permissions('notification.read')
  milestonesFromSchedule(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.fromSchedule(id, principal);
  }

  @ApiOperation({ summary: 'แก้หมุดหมาย (ยังไม่บรรลุ)' })
  @Patch(':id/milestones/:milestoneId')
  @Permissions('notification.read')
  updateMilestone(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: SaveMilestoneDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.update(id, milestoneId, dto, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกหมุดหมาย (งวดที่ผูกไว้ว่างอีกครั้ง)' })
  @Post(':id/milestones/:milestoneId/cancel')
  @Permissions('notification.read')
  cancelMilestone(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.cancel(id, milestoneId, principal);
  }

  @ApiOperation({ summary: 'ยืนยัน/ยกเลิกการยืนยันเกณฑ์การบรรลุทีละข้อ' })
  @Put(':id/milestones/:milestoneId/criteria/:index')
  @Permissions('notification.read')
  tickCriterion(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: TickCriterionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.tick(id, milestoneId, index, dto.met, principal);
  }

  @ApiOperation({
    summary: 'บันทึกว่าบรรลุหมุดหมาย พร้อมหลักฐาน (ไฟล์ไม่บังคับ)',
  })
  @Post(':id/milestones/:milestoneId/achieve')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['achieved_on', 'evidence_note'],
      properties: {
        achieved_on: { type: 'string', format: 'date' },
        evidence_note: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  achieveMilestone(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: AchieveMilestoneDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.milestones.achieve(id, milestoneId, dto, file, principal);
  }

  @ApiOperation({ summary: 'ไฟล์หลักฐานการบรรลุหมุดหมาย' })
  @Get(':id/milestones/:milestoneId/evidence')
  @Permissions('notification.read')
  async milestoneEvidence(
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.milestones.evidence(id, milestoneId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-177 plan ------------------------------------------------------------------

  @ApiOperation({
    summary: 'แผนงาน: โครงสร้างงาน ลำดับ และวันที่ที่คำนวณได้',
  })
  @Get(':id/plan')
  @Permissions('notification.read')
  viewPlan(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.plan.view(id, principal);
  }

  @ApiOperation({
    summary: 'ดูผลกระทบก่อนบันทึก: งานที่เลื่อน วันจบโครงการ และหมุดหมาย',
  })
  @Post(':id/plan/preview')
  @Permissions('notification.read')
  previewPlan(
    @Param('id') id: string,
    @Body() dto: PlanPreviewDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.preview(id, dto, principal);
  }

  @ApiOperation({ summary: 'เพิ่มงานในแผน' })
  @Post(':id/plan/tasks')
  @Permissions('notification.read')
  createTask(
    @Param('id') id: string,
    @Body() dto: SaveTaskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'สร้างงานจากสิ่งส่งมอบในฐานตั้งต้น' })
  @Post(':id/plan/from-deliverables')
  @Permissions('notification.read')
  planFromDeliverables(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.fromDeliverables(id, principal);
  }

  @ApiOperation({ summary: 'แก้งาน ย้ายกลุ่ม หรือเปลี่ยนลำดับ' })
  @Patch(':id/plan/tasks/:taskId')
  @Permissions('notification.read')
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: SaveTaskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.update(id, taskId, dto, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกงาน (พร้อมงานย่อย)' })
  @Post(':id/plan/tasks/:taskId/cancel')
  @Permissions('notification.read')
  cancelTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.cancel(id, taskId, principal);
  }

  @ApiOperation({ summary: 'งานที่ต้องเสร็จก่อนงานนี้' })
  @Put(':id/plan/tasks/:taskId/predecessors')
  @Permissions('notification.read')
  setPredecessors(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: SavePredecessorsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plan.setPredecessors(id, taskId, dto, principal);
  }
}
