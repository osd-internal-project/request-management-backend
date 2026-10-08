import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AppError,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AchieveMilestoneDto,
  AttachCloseDocumentDto,
  SaveCloseoutDto,
  SaveLessonDto,
  SaveStatusReportDto,
  SaveTestItemDto,
  RecordTestDto,
  SaveReadinessItemDto,
  AnswerIntakeDto,
  CheckReadinessDto,
  ReturnIntakeDto,
  SaveDeviationDto,
  BookAcceptanceDto,
  RecordAcceptanceDto,
  AcceptanceItemDoneDto,
  SaveUatFindingDto,
  MoveUatDto,
  SaveInstallationDto,
  SaveSurveyDto,
  AddDevItemsDto,
  MoveDefectDto,
  DeployReleaseDto,
  AttachSoftwareDocumentDto,
  ConfigReasonDto,
  SaveIntegrationDto,
  SaveTechChangeDto,
  AddProjectCostDto,
  BookResourceDto,
  SaveResourceRequestDto,
  WorkloadQueryDto,
  SaveConfigItemDto,
  CarrySoftwareDocumentDto,
  SaveEnvironmentDto,
  SaveReleaseDto,
  SaveDefectDto,
  SurveyPhotoDto,
  SaveDesignDto,
  SaveTechPlanDto,
  ListProjectsQueryDto,
  OpenProjectDto,
  SaveMilestoneDto,
  PlanPreviewDto,
  SavePredecessorsDto,
  RecordBillingDto,
  ReportProgressDto,
  SaveBudgetDto,
  ResolveIssueDto,
  ReviewRiskDto,
  SaveChangeRequestDto,
  SaveCustomerLogDto,
  SaveIssueDto,
  SaveProjectRiskDto,
  SaveTaskDto,
  TaskReportDto,
  SaveProjectMembersDto,
  TickCriterionDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { MAX_EVIDENCE_BYTES, MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { ProgressService } from './progress.service';
import { BudgetService } from './budget.service';
import { ChangeRequestsService } from './change-requests.service';
import { ProjectRisksService } from './project-risks.service';
import { ProjectIssuesService } from './project-issues.service';
import { CustomerLogsService } from './customer-logs.service';
import { PaymentsService } from './payments.service';
import { CloseoutService } from './closeout.service';
import { StatusReportsService } from './status-reports.service';
import { TestsService } from './tests.service';
import { ReadinessService } from './readiness.service';
import { IntakeService } from './intake.service';
import { AsBuiltService } from './as-built.service';
import { AcceptanceService } from './acceptance.service';
import { UatService } from './uat.service';
import {
  InstallationsService,
  type PointPhotos,
} from './installations.service';
import { DesignsService } from './designs.service';
import { TechPlanService } from './tech-plan.service';
import { SurveysService } from './surveys.service';
import { DevPlanService } from './dev-plan.service';
import { DefectsService } from './defects.service';
import { ReleasesService } from './releases.service';
import { SoftwareDocsService } from './software-docs.service';
import { ConfigsService } from './configs.service';
import { IntegrationsService } from './integrations.service';
import { TechChangesService } from './tech-changes.service';
import { ProjectCostsService } from './project-costs.service';
import { ResourcesService } from './resources.service';
import { MAX_TASK_FILE_BYTES, TaskWorkService } from './task-work.service';
import { MAX_FILES_PER_UPDATE } from './task-rules';
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
    private readonly work: TaskWorkService,
    private readonly progress: ProgressService,
    private readonly budget: BudgetService,
    private readonly changes: ChangeRequestsService,
    private readonly risks: ProjectRisksService,
    private readonly issues: ProjectIssuesService,
    private readonly customerLogs: CustomerLogsService,
    private readonly payments: PaymentsService,
    private readonly closeout: CloseoutService,
    private readonly statusReports: StatusReportsService,
    private readonly tests: TestsService,
    private readonly readiness: ReadinessService,
    private readonly intake: IntakeService,
    private readonly asBuilt: AsBuiltService,
    private readonly acceptance: AcceptanceService,
    private readonly uat: UatService,
    private readonly installations: InstallationsService,
    private readonly designs: DesignsService,
    private readonly techPlan: TechPlanService,
    private readonly surveys: SurveysService,
    private readonly devPlan: DevPlanService,
    private readonly defects: DefectsService,
    private readonly releases: ReleasesService,
    private readonly softwareDocs: SoftwareDocsService,
    private readonly configs: ConfigsService,
    private readonly integrations: IntegrationsService,
    private readonly techChanges: TechChangesService,
    private readonly projectCosts: ProjectCostsService,
    private readonly resources: ResourcesService,
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

  @ApiOperation({
    summary:
      'CD-68 โครงการของลูกค้ารายนี้ (เฉพาะที่ผู้ใช้เห็น) พร้อมสุขภาพและสถานะรับมอบงาน',
  })
  @Get('by-customer/:customerId')
  @Permissions('notification.read')
  ofCustomer(
    @Param('customerId') customerId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.statusReports.ofCustomer(customerId, principal);
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

  // --- CD-179 budget ----------------------------------------------------------------

  @ApiOperation({ summary: 'งบอ้างอิง: ฉบับปัจจุบัน และทุกฉบับ' })
  @Get(':id/budget')
  @Permissions('notification.read')
  viewBudget(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.budget.view(id, principal);
  }

  @ApiOperation({ summary: 'ตั้งร่างงบจากฐานตั้งต้น (ครั้งแรกเท่านั้น)' })
  @Post(':id/budget')
  @Permissions('notification.read')
  startBudget(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.budget.start(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกร่างงบ (ทั้งฉบับ)' })
  @Put(':id/budget/draft')
  @Permissions('notification.read')
  saveBudget(
    @Param('id') id: string,
    @Body() dto: SaveBudgetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.budget.saveDraft(id, dto, principal);
  }

  @ApiOperation({
    summary: 'ยืนยันงบ — หลังจากนี้เปลี่ยนได้ผ่านคำขอเปลี่ยนแปลงเท่านั้น',
  })
  @Post(':id/budget/lock')
  @Permissions('notification.read')
  lockBudget(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.budget.lock(id, principal);
  }

  // --- CD-185 change requests -------------------------------------------------------

  @ApiOperation({ summary: 'คำขอเปลี่ยนแปลงของโครงการ พร้อมผลกระทบ' })
  @Get(':id/changes')
  @Permissions('notification.read')
  listChanges(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.changes.list(id, principal);
  }

  @ApiOperation({ summary: 'ร่างคำขอเปลี่ยนแปลง' })
  @Post(':id/changes')
  @Permissions('notification.read')
  createChange(
    @Param('id') id: string,
    @Body() dto: SaveChangeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.changes.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ร่างคำขอเปลี่ยนแปลง' })
  @Patch(':id/changes/:changeId')
  @Permissions('notification.read')
  updateChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @Body() dto: SaveChangeRequestDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.changes.update(id, changeId, dto, principal);
  }

  @ApiOperation({ summary: 'ส่งคำขอเปลี่ยนแปลงให้คณะกรรมการพิจารณา' })
  @Post(':id/changes/:changeId/submit')
  @Permissions('notification.read')
  submitChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.changes.submit(id, changeId, principal, authorization);
  }

  @ApiOperation({ summary: 'ยกเลิกร่างคำขอเปลี่ยนแปลง' })
  @Post(':id/changes/:changeId/cancel')
  @Permissions('notification.read')
  cancelChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.changes.cancel(id, changeId, principal);
  }

  // --- CD-221 tests against the scope ------------------------------------------------

  @ApiOperation({
    summary: 'แผนทดสอบตามขอบเขตงานรายข้อ ผลทดสอบ และความครบถ้วน',
  })
  @Get(':id/tests')
  @Permissions('notification.read')
  viewTests(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.tests.view(id, principal);
  }

  @ApiOperation({ summary: 'เพิ่มข้อทดสอบเอง (ผู้จัดการโครงการ)' })
  @Post(':id/tests')
  @Permissions('notification.read')
  addTest(
    @Param('id') id: string,
    @Body() dto: SaveTestItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tests.add(id, dto, principal);
  }

  @ApiOperation({
    summary: 'วิธีทดสอบ ผู้ทดสอบ หรือยกเว้นข้อทดสอบ (ผู้จัดการโครงการ)',
  })
  @Patch(':id/tests/:itemId')
  @Permissions('notification.read')
  updateTest(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: SaveTestItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tests.update(id, itemId, dto, principal);
  }

  @ApiOperation({
    summary: 'บันทึกผลทดสอบพร้อมหลักฐาน (ทีมโครงการ) — ไม่ผ่านเปิดปัญหาให้',
  })
  @Post(':id/tests/:itemId/results')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'string', enum: ['pass', 'fail'] },
        note: { type: 'string' },
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
  recordTest(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: RecordTestDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.tests.record(id, itemId, dto, file, principal);
  }

  @ApiOperation({ summary: 'ไฟล์หลักฐานผลทดสอบ' })
  @Get(':id/tests/:itemId/results/:runId/file')
  @Permissions('notification.read')
  async testEvidence(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Param('runId') runId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.tests.evidence(id, itemId, runId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-209 technical plan ---------------------------------------------------------

  @ApiOperation({
    summary:
      'แผนงานเทคนิค: ทีมและอุปกรณ์ต่องาน อุปกรณ์รายสัปดาห์ และจุดส่งต่อที่ 7',
  })
  @Get(':id/tech-plan')
  @Permissions('notification.read')
  viewTechPlan(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techPlan.view(id, principal);
  }

  @ApiOperation({ summary: 'ตั้งทีมและอุปกรณ์ของงาน (ผู้จัดการโครงการ)' })
  @Put(':id/tech-plan/:taskId')
  @Permissions('notification.read')
  saveTechPlan(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: SaveTechPlanDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techPlan.saveTask(id, taskId, dto, principal);
  }

  // --- CD-211 detailed design ------------------------------------------------------

  @ApiOperation({
    summary: 'แบบรายละเอียดทุกเวอร์ชัน และแบบที่ใช้อยู่ (อนุมัติล่าสุด)',
  })
  @Get(':id/designs')
  @Permissions('notification.read')
  viewDesigns(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.designs.view(id, principal);
  }

  @ApiOperation({
    summary: 'เริ่มแบบเวอร์ชันใหม่ (คัดลอกจากแบบที่ใช้อยู่) — ทีมโครงการ',
  })
  @Post(':id/designs')
  @Permissions('notification.read')
  createDesign(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.designs.create(id, principal);
  }

  @ApiOperation({ summary: 'แก้ร่างแบบ' })
  @Patch(':id/designs/:designId')
  @Permissions('notification.read')
  updateDesign(
    @Param('id') id: string,
    @Param('designId') designId: string,
    @Body() dto: SaveDesignDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.designs.update(id, designId, dto, principal);
  }

  @ApiOperation({ summary: 'แนบไฟล์แบบ (ร่าง)' })
  @Post(':id/designs/:designId/files')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  attachDesignFile(
    @Param('id') id: string,
    @Param('designId') designId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.designs.attach(id, designId, file, principal);
  }

  @ApiOperation({ summary: 'นำไฟล์ออกจากร่างแบบ' })
  @Delete(':id/designs/:designId/files/:fileId')
  @Permissions('notification.read')
  detachDesignFile(
    @Param('id') id: string,
    @Param('designId') designId: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.designs.detach(id, designId, fileId, principal);
  }

  @ApiOperation({ summary: 'ไฟล์แบบ' })
  @Get(':id/design-files/:fileId')
  @Permissions('notification.read')
  async designFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.designs.download(id, fileId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'ส่งร่างแบบขออนุมัติ (ผู้จัดการโครงการ)' })
  @Post(':id/designs/:designId/submit')
  @Permissions('notification.read')
  submitDesign(
    @Param('id') id: string,
    @Param('designId') designId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.designs.submit(id, designId, principal, authorization);
  }

  // --- CD-216 installation ---------------------------------------------------------

  @ApiOperation({
    summary: 'งานติดตั้งรายจุด และจำนวนที่ติดตั้งเทียบ BOQ',
  })
  @Get(':id/installations')
  @Permissions('notification.read')
  viewInstallations(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installations.view(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกจุดติดตั้ง (ทีมโครงการ) — รูปก่อน/หลัง หมายเลขเครื่อง',
  })
  @Post(':id/installations')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        boq_index: { type: 'string' },
        serial_no: { type: 'string' },
        note: { type: 'string' },
        installed_on: { type: 'string', format: 'date' },
        before: { type: 'string', format: 'binary' },
        after: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'before', maxCount: 1 },
        { name: 'after', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_EVIDENCE_BYTES }, defParamCharset: 'utf8' },
    ),
  )
  addInstallation(
    @Param('id') id: string,
    @Body() dto: SaveInstallationDto,
    @UploadedFiles() photos: PointPhotos | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installations.add(id, dto, photos ?? {}, principal);
  }

  @ApiOperation({ summary: 'แก้จุดติดตั้ง หรือบันทึกว่าติดตั้งแล้ว' })
  @Post(':id/installations/:pointId')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        boq_index: { type: 'string' },
        serial_no: { type: 'string' },
        note: { type: 'string' },
        installed_on: { type: 'string', format: 'date' },
        before: { type: 'string', format: 'binary' },
        after: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'before', maxCount: 1 },
        { name: 'after', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_EVIDENCE_BYTES }, defParamCharset: 'utf8' },
    ),
  )
  updateInstallation(
    @Param('id') id: string,
    @Param('pointId') pointId: string,
    @Body() dto: SaveInstallationDto,
    @UploadedFiles() photos: PointPhotos | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installations.update(id, pointId, dto, photos ?? {}, principal);
  }

  @ApiOperation({ summary: 'ลบจุดติดตั้ง (ผู้บันทึกหรือผู้จัดการโครงการ)' })
  @Delete(':id/installations/:pointId')
  @Permissions('notification.read')
  removeInstallation(
    @Param('id') id: string,
    @Param('pointId') pointId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.installations.remove(id, pointId, principal);
  }

  @ApiOperation({ summary: 'รูปก่อน/หลังติดตั้ง' })
  @Get(':id/installations/:pointId/photo/:which')
  @Permissions('notification.read')
  async installationPhoto(
    @Param('id') id: string,
    @Param('pointId') pointId: string,
    @Param('which') which: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.installations.photo(id, pointId, which, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-180 จัดสรรทรัพยากร ----------------------------------------------------------

  @ApiOperation({
    summary:
      'ทีมที่จองในโครงการ วันที่จองเกินเวลาว่าง การจัดลำดับ และคำขอทีมเพิ่ม',
  })
  @Get(':id/resources')
  @Permissions('notification.read')
  viewResources(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.view(id, principal);
  }

  @ApiOperation({
    summary:
      'ตรวจก่อนจอง — วันที่จะเกินเวลาว่าง และโครงการที่ชน (ผู้จัดการโครงการ)',
  })
  @Post(':id/resources/preview')
  @Permissions('notification.read')
  previewBooking(
    @Param('id') id: string,
    @Body() dto: BookResourceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.preview(id, dto, principal);
  }

  @ApiOperation({
    summary:
      'จองคนเข้าโครงการ — จองเกินเวลาว่างต้องระบุลำดับและเหตุผล (ผู้จัดการโครงการ)',
  })
  @Post(':id/resources/bookings')
  @Permissions('notification.read')
  bookResource(
    @Param('id') id: string,
    @Body() dto: BookResourceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.book(id, dto, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกการจอง (ผู้จัดการโครงการ)' })
  @Delete(':id/resources/bookings/:bookingId')
  @Permissions('notification.read')
  cancelResourceBooking(
    @Param('id') id: string,
    @Param('bookingId') bookingId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.cancelBooking(id, bookingId, principal);
  }

  @ApiOperation({ summary: 'ขอทีมเพิ่ม — ยื่นผ่านระบบคำขอ (ผู้จัดการโครงการ)' })
  @Post(':id/resources/requests')
  @Permissions('notification.read')
  askResources(
    @Param('id') id: string,
    @Body() dto: SaveResourceRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.resources.ask(id, dto, principal, authorization);
  }

  @ApiOperation({ summary: 'ยื่นคำขอทีมเพิ่มที่ค้างเป็นร่างอีกครั้ง' })
  @Post(':id/resources/requests/:requestId/submit')
  @Permissions('notification.read')
  submitResourceRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.resources.submit(id, requestId, principal, authorization);
  }

  @ApiOperation({ summary: 'ปิดคำขอทีมเพิ่มที่ได้คนครบแล้ว' })
  @Post(':id/resources/requests/:requestId/fulfil')
  @Permissions('notification.read')
  fulfilResourceRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.fulfil(id, requestId, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกร่างคำขอทีมเพิ่ม' })
  @Post(':id/resources/requests/:requestId/cancel')
  @Permissions('notification.read')
  cancelResourceRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.cancelRequest(id, requestId, principal);
  }

  // --- CD-190 ติดตามต้นทุนโครงการ -----------------------------------------------------

  @ApiOperation({
    summary:
      'ต้นทุนจริงเทียบงบอ้างอิง ต่อหมวดและรวม — แรงงานจาก Timesheet วัสดุ/อื่น ๆ จาก ERP และที่บันทึกเอง',
  })
  @Get(':id/costs')
  @Permissions('notification.read')
  viewCosts(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.projectCosts.view(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกต้นทุนจริงเอง พร้อมหลักฐาน (ผู้จัดการโครงการ)',
  })
  @Post(':id/costs')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['category', 'description', 'amount', 'incurred_on', 'file'],
      properties: {
        category: { type: 'string', enum: ['material', 'other'] },
        description: { type: 'string' },
        amount: { type: 'string' },
        incurred_on: { type: 'string', format: 'date' },
        vendor_name: { type: 'string' },
        doc_no: { type: 'string' },
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
  addCost(
    @Param('id') id: string,
    @Body() dto: AddProjectCostDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projectCosts.add(id, dto, file, principal);
  }

  @ApiOperation({ summary: 'นำรายการต้นทุนที่บันทึกเองออก (ผู้จัดการโครงการ)' })
  @Delete(':id/costs/:costId')
  @Permissions('notification.read')
  removeCost(
    @Param('id') id: string,
    @Param('costId') costId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.projectCosts.remove(id, costId, principal);
  }

  @ApiOperation({ summary: 'หลักฐานของรายการต้นทุน' })
  @Get(':id/costs/:costId/file')
  @Permissions('notification.read')
  async costEvidence(
    @Param('id') id: string,
    @Param('costId') costId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.projectCosts.evidence(id, costId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'อ่านต้นทุนจาก ERP ตอนนี้ (ผู้จัดการโครงการ)' })
  @Post(':id/costs/sync')
  @Permissions('notification.read')
  syncCosts(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.projectCosts.syncNow(id, principal);
  }

  // --- CD-224 ปรับแก้ทางเทคนิค --------------------------------------------------------

  @ApiOperation({
    summary:
      'การปรับแก้ทางเทคนิค — ผลกระทบต่อ BOQ ต้นทุน ขอบเขต และสถานะอนุมัติ',
  })
  @Get(':id/tech-changes')
  @Permissions('notification.read')
  viewTechChanges(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techChanges.view(id, principal);
  }

  @ApiOperation({ summary: 'ร่างการปรับแก้ทางเทคนิค (ทีมโครงการ)' })
  @Post(':id/tech-changes')
  @Permissions('notification.read')
  createTechChange(
    @Param('id') id: string,
    @Body() dto: SaveTechChangeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techChanges.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ร่างการปรับแก้ (ผู้บันทึกหรือผู้จัดการ)' })
  @Put(':id/tech-changes/:techChangeId')
  @Permissions('notification.read')
  updateTechChange(
    @Param('id') id: string,
    @Param('techChangeId') techChangeId: string,
    @Body() dto: SaveTechChangeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techChanges.update(id, techChangeId, dto, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกร่างการปรับแก้' })
  @Post(':id/tech-changes/:techChangeId/cancel')
  @Permissions('notification.read')
  cancelTechChange(
    @Param('id') id: string,
    @Param('techChangeId') techChangeId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techChanges.cancel(id, techChangeId, principal);
  }

  @ApiOperation({
    summary: 'เปิดคำขอเปลี่ยนแปลง (CR) จากการปรับแก้ที่กระทบขอบเขต (ผู้จัดการ)',
  })
  @Post(':id/tech-changes/:techChangeId/change-request')
  @Permissions('notification.read')
  openTechChangeCr(
    @Param('id') id: string,
    @Param('techChangeId') techChangeId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.techChanges.openChange(id, techChangeId, principal);
  }

  @ApiOperation({ summary: 'ยื่นขออนุมัติการปรับแก้ (ผู้จัดการโครงการ)' })
  @Post(':id/tech-changes/:techChangeId/submit')
  @Permissions('notification.read')
  submitTechChange(
    @Param('id') id: string,
    @Param('techChangeId') techChangeId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.techChanges.submit(id, techChangeId, principal, authorization);
  }

  // --- CD-219 เชื่อมต่อระบบ -----------------------------------------------------------

  @ApiOperation({
    summary: 'จุดเชื่อมต่อกับระบบอื่นของลูกค้า ผู้รับผิดชอบ และผลทดสอบล่าสุด',
  })
  @Get(':id/integrations')
  @Permissions('notification.read')
  viewIntegrations(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.view(id, principal);
  }

  @ApiOperation({
    summary:
      'บันทึกจุดเชื่อมต่อ (ทีมโครงการ) — สร้างข้อทดสอบการเชื่อมต่อให้ด้วย',
  })
  @Post(':id/integrations')
  @Permissions('notification.read')
  addIntegration(
    @Param('id') id: string,
    @Body() dto: SaveIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.add(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้จุดเชื่อมต่อ (ทีมโครงการ)' })
  @Put(':id/integrations/:integrationId')
  @Permissions('notification.read')
  updateIntegration(
    @Param('id') id: string,
    @Param('integrationId') integrationId: string,
    @Body() dto: SaveIntegrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.update(id, integrationId, dto, principal);
  }

  @ApiOperation({
    summary: 'นำจุดเชื่อมต่อออก พร้อมข้อทดสอบ (ผู้บันทึกหรือผู้จัดการ)',
  })
  @Delete(':id/integrations/:integrationId')
  @Permissions('notification.read')
  removeIntegration(
    @Param('id') id: string,
    @Param('integrationId') integrationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.integrations.remove(id, integrationId, principal);
  }

  // --- CD-217 ตั้งค่าระบบ -------------------------------------------------------------

  @ApiOperation({
    summary: 'ค่าตั้งค่าของโครงการ (ค่าลับแสดงเป็น ••••••) · q = ค้นหา',
  })
  @Get(':id/configs')
  @Permissions('notification.read')
  viewConfigs(
    @Param('id') id: string,
    @Query('q') q: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.view(id, principal, q ?? '');
  }

  @ApiOperation({ summary: 'บันทึกค่าตั้งค่า (ทีมโครงการ)' })
  @Post(':id/configs')
  @Permissions('notification.read')
  addConfig(
    @Param('id') id: string,
    @Body() dto: SaveConfigItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.add(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ค่าตั้งค่า พร้อมเหตุผล (ทีมโครงการ)' })
  @Put(':id/configs/:itemId')
  @Permissions('notification.read')
  updateConfig(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: SaveConfigItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.update(id, itemId, dto, principal);
  }

  @ApiOperation({
    summary: 'นำค่าตั้งค่าออก พร้อมเหตุผล (ผู้บันทึกหรือผู้จัดการ)',
  })
  @Post(':id/configs/:itemId/remove')
  @Permissions('notification.read')
  removeConfig(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: ConfigReasonDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.remove(id, itemId, dto.reason, principal);
  }

  @ApiOperation({
    summary: 'แสดงค่าลับ (ทีมโครงการ) — บันทึกทุกครั้งว่าใครดูเมื่อไร',
  })
  @Post(':id/configs/:itemId/reveal')
  @Permissions('notification.read')
  revealConfig(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.reveal(id, itemId, principal);
  }

  @ApiOperation({ summary: 'ประวัติการเปลี่ยนค่า (ค่าลับแสดงเป็น ••••••)' })
  @Get(':id/configs/:itemId/history')
  @Permissions('notification.read')
  configHistory(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.historyOf(id, itemId, principal);
  }

  @ApiOperation({ summary: 'คืนค่าจากประวัติ พร้อมเหตุผล (ทีมโครงการ)' })
  @Post(':id/configs/:itemId/history/:historyId/restore')
  @Permissions('notification.read')
  restoreConfig(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Param('historyId') historyId: string,
    @Body() dto: ConfigReasonDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.restore(id, itemId, historyId, dto.reason, principal);
  }

  // --- CD-215 เอกสารซอฟต์แวร์ --------------------------------------------------------

  @ApiOperation({
    summary: 'เอกสารซอฟต์แวร์ตามเวอร์ชัน และที่ยังค้างของเวอร์ชันที่ส่งมอบ',
  })
  @Get(':id/software-docs')
  @Permissions('notification.read')
  viewSoftwareDocs(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softwareDocs.view(id, principal);
  }

  @ApiOperation({ summary: 'แนบเอกสารซอฟต์แวร์ของเวอร์ชันหนึ่ง (ทีมโครงการ)' })
  @Post(':id/software-docs')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'release_id', 'file'],
      properties: {
        title: { type: 'string' },
        release_id: { type: 'string' },
        note: { type: 'string' },
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
  attachSoftwareDoc(
    @Param('id') id: string,
    @Body() dto: AttachSoftwareDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softwareDocs.attach(id, dto, file, principal);
  }

  @ApiOperation({
    summary: 'ใช้ไฟล์เดิมกับเวอร์ชันใหม่ (เนื้อหาไม่เปลี่ยน)',
  })
  @Post(':id/software-docs/:documentId/carry')
  @Permissions('notification.read')
  carrySoftwareDoc(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() dto: CarrySoftwareDocumentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softwareDocs.carry(id, documentId, dto.release_id, principal);
  }

  @ApiOperation({
    summary: 'นำเอกสารซอฟต์แวร์ออก (ผู้แนบหรือผู้จัดการโครงการ)',
  })
  @Delete(':id/software-docs/:documentId')
  @Permissions('notification.read')
  detachSoftwareDoc(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.softwareDocs.detach(id, documentId, principal);
  }

  @ApiOperation({ summary: 'ไฟล์เอกสารซอฟต์แวร์' })
  @Get(':id/software-docs/:documentId/file')
  @Permissions('notification.read')
  async softwareDocFile(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.softwareDocs.download(id, documentId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-214 Release และ Environment ------------------------------------------------

  @ApiOperation({
    summary: 'environment ของโครงการ เวอร์ชันที่ใช้อยู่ และประวัติการ deploy',
  })
  @Get(':id/releases')
  @Permissions('notification.read')
  viewReleases(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.view(id, principal);
  }

  @ApiOperation({ summary: 'เพิ่ม environment (ผู้จัดการโครงการ)' })
  @Post(':id/environments')
  @Permissions('notification.read')
  addEnvironment(
    @Param('id') id: string,
    @Body() dto: SaveEnvironmentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.saveEnvironment(id, null, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ environment (ผู้จัดการโครงการ)' })
  @Put(':id/environments/:envId')
  @Permissions('notification.read')
  updateEnvironment(
    @Param('id') id: string,
    @Param('envId') envId: string,
    @Body() dto: SaveEnvironmentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.saveEnvironment(id, envId, dto, principal);
  }

  @ApiOperation({ summary: 'เอา environment ออก (ประวัติ deploy ยังอยู่)' })
  @Delete(':id/environments/:envId')
  @Permissions('notification.read')
  removeEnvironment(
    @Param('id') id: string,
    @Param('envId') envId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.removeEnvironment(id, envId, principal);
  }

  @ApiOperation({ summary: 'บันทึกเวอร์ชันใหม่ (ทีมโครงการ)' })
  @Post(':id/releases')
  @Permissions('notification.read')
  addRelease(
    @Param('id') id: string,
    @Body() dto: SaveReleaseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.addRelease(id, dto, principal);
  }

  @ApiOperation({
    summary:
      'บันทึกการ deploy — production ต้องผ่าน UAT และไม่มี blocker ค้าง (ผู้จัดการข้ามได้พร้อมเหตุผล)',
  })
  @Post(':id/releases/:releaseId/deploy')
  @Permissions('notification.read')
  deployRelease(
    @Param('id') id: string,
    @Param('releaseId') releaseId: string,
    @Body() dto: DeployReleaseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.releases.deploy(id, releaseId, dto, principal);
  }

  // --- CD-213 ติดตามงานพัฒนาและข้อบกพร่อง ----------------------------------------------

  @ApiOperation({
    summary:
      'ข้อ SOW ของงานพัฒนา ผลทดสอบ และข้อบกพร่อง — ข้อที่ยังพิสูจน์ไม่ได้ค้างเป็นรายการ',
  })
  @Get(':id/defects')
  @Permissions('notification.read')
  viewDefects(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.defects.view(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกข้อบกพร่อง (ทีมโครงการ) ผูกกับข้อ SOW' })
  @Post(':id/defects')
  @Permissions('notification.read')
  addDefect(
    @Param('id') id: string,
    @Body() dto: SaveDefectDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.defects.add(id, dto, principal);
  }

  @ApiOperation({
    summary:
      'แก้แล้ว · ทดสอบซ้ำผ่าน · ทดสอบซ้ำไม่ผ่าน (เปิดใหม่) · ยกเลิก (ผู้จัดการโครงการ)',
  })
  @Post(':id/defects/:defectId/move')
  @Permissions('notification.read')
  moveDefect(
    @Param('id') id: string,
    @Param('defectId') defectId: string,
    @Body() dto: MoveDefectDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.defects.move(id, defectId, dto, principal);
  }

  // --- CD-212 แผนงานพัฒนาซอฟต์แวร์ ---------------------------------------------------

  @ApiOperation({
    summary:
      'แผนงานพัฒนาซอฟต์แวร์ — รอบงานในแผน และข้อ SOW ที่ยังไม่อยู่ในรอบใด',
  })
  @Get(':id/dev-plan')
  @Permissions('notification.read')
  viewDevPlan(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.devPlan.view(id, principal);
  }

  @ApiOperation({ summary: 'เพิ่มรอบงานพัฒนา (งานสรุปในแผน)' })
  @Post(':id/dev-plan/iterations')
  @Permissions('notification.read')
  addDevIteration(
    @Param('id') id: string,
    @Body() dto: SaveTaskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.devPlan.addIteration(id, dto, principal);
  }

  @ApiOperation({ summary: 'แตกข้อ SOW ลงรอบงาน — ข้อละหนึ่งงานในแผน' })
  @Post(':id/dev-plan/iterations/:taskId/items')
  @Permissions('notification.read')
  addDevItems(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: AddDevItemsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.devPlan.addItems(id, taskId, dto, principal);
  }

  // --- CD-210 สำรวจหน้างาน ------------------------------------------------------------

  @ApiOperation({
    summary: 'การสำรวจหน้างาน และสมมติฐานของ Solution ที่ต้องตรวจ',
  })
  @Get(':id/surveys')
  @Permissions('notification.read')
  viewSurveys(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.view(id, principal);
  }

  @ApiOperation({
    summary:
      'ซิงก์ร่างการสำรวจจากเครื่อง (รหัสสร้างบนเครื่อง ส่งซ้ำ = แก้ร่างเดิม)',
  })
  @Post(':id/surveys')
  @Permissions('notification.read')
  saveSurvey(
    @Param('id') id: string,
    @Body() dto: SaveSurveyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.save(id, dto, principal);
  }

  @ApiOperation({ summary: 'ซิงก์รูปการสำรวจ (รูปที่ซิงก์แล้วไม่ถูกเพิ่มซ้ำ)' })
  @Post(':id/surveys/:surveyId/photos')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['id', 'file'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        caption: { type: 'string' },
        latitude: { type: 'string' },
        longitude: { type: 'string' },
        taken_at: { type: 'string', format: 'date-time' },
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
  addSurveyPhoto(
    @Param('id') id: string,
    @Param('surveyId') surveyId: string,
    @Body() dto: SurveyPhotoDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.addPhoto(id, surveyId, dto, file, principal);
  }

  @ApiOperation({ summary: 'ลบรูปออกจากร่างการสำรวจ' })
  @Delete(':id/surveys/:surveyId/photos/:photoId')
  @Permissions('notification.read')
  removeSurveyPhoto(
    @Param('id') id: string,
    @Param('surveyId') surveyId: string,
    @Param('photoId') photoId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.removePhoto(id, surveyId, photoId, principal);
  }

  @ApiOperation({ summary: 'รูปการสำรวจ' })
  @Get(':id/surveys/:surveyId/photos/:photoId')
  @Permissions('notification.read')
  async surveyPhoto(
    @Param('id') id: string,
    @Param('surveyId') surveyId: string,
    @Param('photoId') photoId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.surveys.photo(id, surveyId, photoId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({
    summary:
      'แปลงสมมติฐานที่ไม่ตรงหน้างานเป็นคำขอเปลี่ยนแปลง (ผู้จัดการโครงการ)',
  })
  @Post(':id/surveys/:surveyId/assumptions/:index/change')
  @Permissions('notification.read')
  surveyToChange(
    @Param('id') id: string,
    @Param('surveyId') surveyId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.toChange(id, surveyId, index, principal);
  }

  @ApiOperation({
    summary: 'ปิดการสำรวจ — ทุกข้อต้องตรวจ ข้อที่ไม่ตรงต้องเป็นคำขอเปลี่ยนแปลง',
  })
  @Post(':id/surveys/:surveyId/complete')
  @Permissions('notification.read')
  completeSurvey(
    @Param('id') id: string,
    @Param('surveyId') surveyId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.surveys.complete(id, surveyId, principal);
  }

  // --- CD-222 UAT -------------------------------------------------------------------

  @ApiOperation({
    summary: 'ประเด็นจากการทดสอบของลูกค้า (UAT) และที่ปิดกั้นการตรวจรับ',
  })
  @Get(':id/uat')
  @Permissions('notification.read')
  viewUat(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.uat.view(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกประเด็น UAT (ทีมโครงการ)' })
  @Post(':id/uat')
  @Permissions('notification.read')
  addUat(
    @Param('id') id: string,
    @Body() dto: SaveUatFindingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.uat.add(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ประเด็น UAT ที่ยังเปิดอยู่' })
  @Patch(':id/uat/:findingId')
  @Permissions('notification.read')
  updateUat(
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Body() dto: SaveUatFindingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.uat.update(id, findingId, dto, principal);
  }

  @ApiOperation({
    summary:
      'เปลี่ยนสถานะประเด็น UAT: fix · confirm · reopen · defer · undefer (เลื่อนได้เฉพาะผู้จัดการ)',
  })
  @Post(':id/uat/:findingId/:action')
  @Permissions('notification.read')
  moveUat(
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Param('action') action: string,
    @Body() dto: MoveUatDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.uat.move(id, findingId, action, dto, principal);
  }

  // --- CD-189 acceptance -------------------------------------------------------------

  @ApiOperation({
    summary: 'การตรวจรับ: ความพร้อม รอบนัด ผล และรายการค้าง',
  })
  @Get(':id/acceptances')
  @Permissions('notification.read')
  viewAcceptances(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.view(id, principal);
  }

  @ApiOperation({
    summary: 'นัดตรวจรับ (เมื่อตรวจความพร้อมผ่าน) — ผู้จัดการโครงการ',
  })
  @Post(':id/acceptances')
  @Permissions('notification.read')
  bookAcceptance(
    @Param('id') id: string,
    @Body() dto: BookAcceptanceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.book(id, dto, principal);
  }

  @ApiOperation({ summary: 'เลื่อนนัดหรือแก้รายละเอียดนัดตรวจรับ' })
  @Patch(':id/acceptances/:acceptanceId')
  @Permissions('notification.read')
  updateAcceptance(
    @Param('id') id: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: BookAcceptanceDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.update(id, acceptanceId, dto, principal);
  }

  @ApiOperation({ summary: 'ยกเลิกนัดตรวจรับ' })
  @Post(':id/acceptances/:acceptanceId/cancel')
  @Permissions('notification.read')
  cancelAcceptance(
    @Param('id') id: string,
    @Param('acceptanceId') acceptanceId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.cancel(id, acceptanceId, principal);
  }

  @ApiOperation({
    summary:
      'บันทึกผลตรวจรับ พร้อมใบตรวจรับที่ลงนาม — ผ่านแล้ว milestone บรรลุให้',
  })
  @Post(':id/acceptances/:acceptanceId/result')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['result', 'decided_on'],
      properties: {
        result: {
          type: 'string',
          enum: ['accepted', 'conditional', 'rejected'],
        },
        decided_on: { type: 'string', format: 'date' },
        note: { type: 'string' },
        items: { type: 'string', description: 'JSON array' },
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
  recordAcceptance(
    @Param('id') id: string,
    @Param('acceptanceId') acceptanceId: string,
    @Body() dto: RecordAcceptanceDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.record(id, acceptanceId, dto, file, principal);
  }

  @ApiOperation({
    summary: 'ปิดรายการค้างจากการตรวจรับ (ผู้รับผิดชอบหรือผู้จัดการ)',
  })
  @Post(':id/acceptances/:acceptanceId/items/:itemId/done')
  @Permissions('notification.read')
  closeAcceptanceItem(
    @Param('id') id: string,
    @Param('acceptanceId') acceptanceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: AcceptanceItemDoneDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.acceptance.closeItem(id, acceptanceId, itemId, dto, principal);
  }

  @ApiOperation({ summary: 'ไฟล์ใบตรวจรับที่ลงนาม' })
  @Get(':id/acceptances/:acceptanceId/certificate')
  @Permissions('notification.read')
  async acceptanceCertificate(
    @Param('id') id: string,
    @Param('acceptanceId') acceptanceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.acceptance.certificate(id, acceptanceId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-226 as-built ---------------------------------------------------------------

  @ApiOperation({
    summary: 'เอกสารสภาพจริง: เอกสารที่ต้องมี จุดที่ต่างจากที่ขาย และความครบ',
  })
  @Get(':id/as-built')
  @Permissions('notification.read')
  viewAsBuilt(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.view(id, principal);
  }

  @ApiOperation({ summary: 'แนบเอกสารสภาพจริง (ทีมโครงการ)' })
  @Post(':id/as-built/documents')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'file'],
      properties: {
        title: { type: 'string' },
        note: { type: 'string' },
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
  attachAsBuilt(
    @Param('id') id: string,
    @Body() dto: AttachCloseDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.attach(id, dto, file, principal);
  }

  @ApiOperation({ summary: 'นำเอกสารสภาพจริงออก (ผู้แนบหรือผู้จัดการโครงการ)' })
  @Delete(':id/as-built/documents/:documentId')
  @Permissions('notification.read')
  detachAsBuilt(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.detach(id, documentId, principal);
  }

  @ApiOperation({ summary: 'ไฟล์เอกสารสภาพจริง' })
  @Get(':id/as-built/documents/:documentId/file')
  @Permissions('notification.read')
  async asBuiltFile(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.asBuilt.download(id, documentId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'บันทึกจุดที่ทำจริงต่างจากที่ขาย (ทีมโครงการ)' })
  @Post(':id/as-built/deviations')
  @Permissions('notification.read')
  addDeviation(
    @Param('id') id: string,
    @Body() dto: SaveDeviationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.addDeviation(id, dto, principal);
  }

  @ApiOperation({
    summary:
      'แก้จุดที่ต่าง หรือผูกคำขอเปลี่ยนแปลง (ผูกได้เฉพาะผู้จัดการโครงการ)',
  })
  @Patch(':id/as-built/deviations/:deviationId')
  @Permissions('notification.read')
  updateDeviation(
    @Param('id') id: string,
    @Param('deviationId') deviationId: string,
    @Body() dto: SaveDeviationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.updateDeviation(id, deviationId, dto, principal);
  }

  @ApiOperation({ summary: 'ลบจุดที่ต่าง (ผู้บันทึกหรือผู้จัดการโครงการ)' })
  @Delete(':id/as-built/deviations/:deviationId')
  @Permissions('notification.read')
  removeDeviation(
    @Param('id') id: string,
    @Param('deviationId') deviationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.asBuilt.removeDeviation(id, deviationId, principal);
  }

  // --- CD-176 receiving the work ---------------------------------------------------

  @ApiOperation({
    summary:
      'รับมอบงาน: รายการจากงานส่งมอบทีมขาย Solution/ขอบเขต/BOQ สัญญา และของบริษัท',
  })
  @Get(':id/intake')
  @Permissions('notification.read')
  viewIntake(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.view(id, principal);
  }

  @ApiOperation({
    summary: 'ตรวจรายการรับมอบทีละข้อ: ถูกต้อง หรือไม่ครบพร้อมเหตุผล',
  })
  @Post(':id/intake/answer')
  @Permissions('notification.read')
  answerIntake(
    @Param('id') id: string,
    @Body() dto: AnswerIntakeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.answer(id, dto, principal);
  }

  @ApiOperation({
    summary:
      'ดึงข้อมูลตั้งต้นใหม่ (หลังทีมขาย/เทคนิคแก้) — ข้อที่ข้อมูลเปลี่ยนต้องตรวจใหม่',
  })
  @Post(':id/intake/refresh')
  @Permissions('notification.read')
  refreshIntake(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.refresh(id, principal);
  }

  @ApiOperation({ summary: 'รับมอบงาน (ทุกข้อถูกต้อง)' })
  @Post(':id/intake/accept')
  @Permissions('notification.read')
  acceptIntake(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.accept(id, principal);
  }

  @ApiOperation({
    summary: 'ตีกลับงาน — แต่ละฝ่ายได้รับเฉพาะข้อที่ไม่ครบของตัวเอง',
  })
  @Post(':id/intake/return')
  @Permissions('notification.read')
  returnIntake(
    @Param('id') id: string,
    @Body() dto: ReturnIntakeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.intake.returnWork(id, dto, principal);
  }

  // --- CD-225 readiness before handover ---------------------------------------------

  @ApiOperation({
    summary:
      'ตรวจความพร้อมก่อนส่งมอบ: รายการตรวจ ข้อที่ระบบตรวจเอง และความพร้อม',
  })
  @Get(':id/readiness')
  @Permissions('notification.read')
  viewReadiness(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.view(id, principal);
  }

  @ApiOperation({ summary: 'เริ่มตรวจ: คัดลอกรายการตรวจมาตรฐานของบริษัท' })
  @Post(':id/readiness/start')
  @Permissions('notification.read')
  startReadiness(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.start(id, principal);
  }

  @ApiOperation({ summary: 'เพิ่มรายการตรวจ (ผู้จัดการโครงการ)' })
  @Post(':id/readiness')
  @Permissions('notification.read')
  addReadiness(
    @Param('id') id: string,
    @Body() dto: SaveReadinessItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.add(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้รายการตรวจ หรือผู้ตรวจ (ผู้จัดการโครงการ)' })
  @Patch(':id/readiness/:lineId')
  @Permissions('notification.read')
  updateReadiness(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: SaveReadinessItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.update(id, lineId, dto, principal);
  }

  @ApiOperation({ summary: 'นำรายการตรวจออก (ผู้จัดการโครงการ)' })
  @Delete(':id/readiness/:lineId')
  @Permissions('notification.read')
  removeReadiness(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.remove(id, lineId, principal);
  }

  @ApiOperation({
    summary: 'บันทึกผลตรวจ ผ่าน/ไม่ผ่าน พร้อมวันที่ (ผู้ตรวจหรือผู้จัดการ)',
  })
  @Post(':id/readiness/:lineId/check')
  @Permissions('notification.read')
  checkReadiness(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: CheckReadinessDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.readiness.check(id, lineId, dto, principal);
  }

  // --- CD-192 weekly status reports ------------------------------------------------

  @ApiOperation({
    summary: 'สุขภาพโครงการตอนนี้ และรายงานสถานะรายสัปดาห์',
  })
  @Get(':id/status-reports')
  @Permissions('notification.read')
  listStatusReports(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.statusReports.list(id, principal);
  }

  @ApiOperation({
    summary: 'ร่างรายงานสัปดาห์นี้ หรืออัปเดตตัวเลขของร่าง',
  })
  @Post(':id/status-reports')
  @Permissions('notification.read')
  draftStatusReport(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.statusReports.draft(id, principal);
  }

  @ApiOperation({ summary: 'แก้ข้อความในร่างรายงาน' })
  @Patch(':id/status-reports/:reportId')
  @Permissions('notification.read')
  saveStatusReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @Body() dto: SaveStatusReportDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.statusReports.update(id, reportId, dto, principal);
  }

  @ApiOperation({ summary: 'ส่งรายงานสถานะ (ตัวเลขถูกตรึงไว้)' })
  @Post(':id/status-reports/:reportId/submit')
  @Permissions('notification.read')
  submitStatusReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.statusReports.submit(id, reportId, principal);
  }

  // --- CD-191 close-out -------------------------------------------------------------

  @ApiOperation({
    summary: 'ปิดโครงการ: รายการตรวจ เอกสารปิด บทเรียน และคำขอปิด',
  })
  @Get(':id/closeout')
  @Permissions('notification.read')
  viewCloseout(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.view(id, principal);
  }

  @ApiOperation({ summary: 'สรุปการปิดโครงการ (ผู้จัดการโครงการ)' })
  @Put(':id/closeout')
  @Permissions('notification.read')
  saveCloseout(
    @Param('id') id: string,
    @Body() dto: SaveCloseoutDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.save(id, dto, principal);
  }

  @ApiOperation({ summary: 'แนบเอกสารปิดโครงการ' })
  @Post(':id/closeout/documents')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'file'],
      properties: {
        title: { type: 'string' },
        note: { type: 'string' },
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
  attachCloseDocument(
    @Param('id') id: string,
    @Body() dto: AttachCloseDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.attach(id, dto, file, principal);
  }

  @ApiOperation({ summary: 'นำเอกสารปิดโครงการออกจากรายการ' })
  @Delete(':id/closeout/documents/:documentId')
  @Permissions('notification.read')
  detachCloseDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.detach(id, documentId, principal);
  }

  @ApiOperation({ summary: 'ไฟล์เอกสารปิดโครงการ' })
  @Get(':id/closeout/documents/:documentId/file')
  @Permissions('notification.read')
  async closeDocumentFile(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.closeout.download(id, documentId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'บันทึกบทเรียน (ทีมโครงการ)' })
  @Post(':id/closeout/lessons')
  @Permissions('notification.read')
  addLesson(
    @Param('id') id: string,
    @Body() dto: SaveLessonDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.addLesson(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้บทเรียน (ผู้บันทึกหรือผู้จัดการโครงการ)' })
  @Patch(':id/closeout/lessons/:lessonId')
  @Permissions('notification.read')
  updateLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @Body() dto: SaveLessonDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.updateLesson(id, lessonId, dto, principal);
  }

  @ApiOperation({ summary: 'ลบบทเรียน (ผู้บันทึกหรือผู้จัดการโครงการ)' })
  @Delete(':id/closeout/lessons/:lessonId')
  @Permissions('notification.read')
  removeLesson(
    @Param('id') id: string,
    @Param('lessonId') lessonId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.closeout.removeLesson(id, lessonId, principal);
  }

  @ApiOperation({
    summary: 'ส่งคำขอปิดโครงการให้ผู้บริหารโครงการอนุมัติ',
  })
  @Post(':id/closeout/submit')
  @Permissions('notification.read')
  submitCloseout(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.closeout.submit(id, principal, authorization);
  }

  // --- CD-193 installments -----------------------------------------------------------

  @ApiOperation({
    summary: 'งวดชำระ: วางบิล รับเงิน เลยกำหนด และพยากรณ์กระแสเงินสด',
  })
  @Get(':id/payments')
  @Permissions('notification.read')
  viewPayments(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.payments.view(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกการวางบิล/รับเงินของงวด (จนกว่า SAP จะเชื่อม)',
  })
  @Put(':id/payments/:seq')
  @Permissions('notification.read')
  recordBilling(
    @Param('id') id: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: RecordBillingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.payments.record(id, seq, dto, principal);
  }

  // --- CD-186 customer coordination --------------------------------------------------

  @ApiOperation({ summary: 'บันทึกการประสานงานและการตัดสินใจของลูกค้า' })
  @Get(':id/customer-logs')
  @Permissions('notification.read')
  listCustomerLogs(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customerLogs.list(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกการประสานงานกับลูกค้า (ทีมโครงการ)' })
  @Post(':id/customer-logs')
  @Permissions('notification.read')
  createCustomerLog(
    @Param('id') id: string,
    @Body() dto: SaveCustomerLogDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customerLogs.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้บันทึกการประสานงาน' })
  @Patch(':id/customer-logs/:logId')
  @Permissions('notification.read')
  updateCustomerLog(
    @Param('id') id: string,
    @Param('logId') logId: string,
    @Body() dto: SaveCustomerLogDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customerLogs.update(id, logId, dto, principal);
  }

  @ApiOperation({
    summary: 'แปลงการตัดสินใจที่กระทบขอบเขตเป็นคำขอเปลี่ยนแปลง (ร่าง)',
  })
  @Post(':id/customer-logs/:logId/change')
  @Permissions('notification.read')
  customerLogToChange(
    @Param('id') id: string,
    @Param('logId') logId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customerLogs.toChange(id, logId, principal);
  }

  // --- CD-184 issues ----------------------------------------------------------------

  @ApiOperation({ summary: 'ปัญหาระหว่างทางของโครงการ' })
  @Get(':id/issues')
  @Permissions('notification.read')
  listIssues(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.issues.list(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกปัญหา (เจ้าของและเส้นตายบังคับ)' })
  @Post(':id/issues')
  @Permissions('notification.read')
  createIssue(
    @Param('id') id: string,
    @Body() dto: SaveIssueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.issues.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'แก้ปัญหาที่ยังเปิดอยู่' })
  @Patch(':id/issues/:issueId')
  @Permissions('notification.read')
  updateIssue(
    @Param('id') id: string,
    @Param('issueId') issueId: string,
    @Body() dto: SaveIssueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.issues.update(id, issueId, dto, principal);
  }

  @ApiOperation({ summary: 'ปิดปัญหาพร้อมวิธีแก้ (เจ้าของปัญหาหรือผู้จัดการ)' })
  @Post(':id/issues/:issueId/resolve')
  @Permissions('notification.read')
  resolveIssue(
    @Param('id') id: string,
    @Param('issueId') issueId: string,
    @Body() dto: ResolveIssueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.issues.resolve(id, issueId, dto, principal);
  }

  @ApiOperation({ summary: 'แปลงปัญหาเป็นคำขอเปลี่ยนแปลง (ร่าง)' })
  @Post(':id/issues/:issueId/change')
  @Permissions('notification.read')
  issueToChange(
    @Param('id') id: string,
    @Param('issueId') issueId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.issues.toChange(id, issueId, principal);
  }

  // --- CD-183 risks -----------------------------------------------------------------

  @ApiOperation({ summary: 'ความเสี่ยงของโครงการ' })
  @Get(':id/risks')
  @Permissions('notification.read')
  listRisks(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.risks.list(id, principal);
  }

  @ApiOperation({ summary: 'เพิ่มความเสี่ยง' })
  @Post(':id/risks')
  @Permissions('notification.read')
  createRisk(
    @Param('id') id: string,
    @Body() dto: SaveProjectRiskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.risks.create(id, dto, principal);
  }

  @ApiOperation({ summary: 'รับความเสี่ยงต่อจากทีมเทคนิคและฝ่ายกฎหมาย' })
  @Post(':id/risks/take-over')
  @Permissions('notification.read')
  takeOverRisks(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.risks.takeOver(id, principal);
  }

  @ApiOperation({
    summary: 'แก้ความเสี่ยง (เจ้าของ แผนรับมือ คะแนน สถานะ รอบทบทวน)',
  })
  @Patch(':id/risks/:riskId')
  @Permissions('notification.read')
  updateRisk(
    @Param('id') id: string,
    @Param('riskId') riskId: string,
    @Body() dto: SaveProjectRiskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.risks.update(id, riskId, dto, principal);
  }

  @ApiOperation({ summary: 'บันทึกการทบทวนความเสี่ยง' })
  @Post(':id/risks/:riskId/reviews')
  @Permissions('notification.read')
  reviewRisk(
    @Param('id') id: string,
    @Param('riskId') riskId: string,
    @Body() dto: ReviewRiskDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.risks.review(id, riskId, dto, principal);
  }

  // --- CD-188 progress --------------------------------------------------------------

  @ApiOperation({
    summary:
      'ความคืบหน้า: งานที่ปิดจริง หมุดหมายที่บรรลุ เทียบแผน และตัวเลขที่รายงาน',
  })
  @Get(':id/progress')
  @Permissions('notification.read')
  viewProgress(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.progress.view(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกความคืบหน้าที่รายงาน (ต่างจากค่าคำนวณมากต้องระบุเหตุผล)',
  })
  @Post(':id/progress')
  @Permissions('notification.read')
  reportProgress(
    @Param('id') id: string,
    @Body() dto: ReportProgressDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.progress.report(id, dto, principal);
  }

  // --- CD-181 the work --------------------------------------------------------------

  @ApiOperation({ summary: 'งาน: รายละเอียด รายงานความคืบหน้า และไฟล์' })
  @Get(':id/plan/tasks/:taskId')
  @Permissions('notification.read')
  taskDetail(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.work.detail(id, taskId, principal);
  }

  @ApiOperation({
    summary:
      'รายงานงาน: บันทึก รูป/ไฟล์ และเปลี่ยนสถานะ (ผู้รับผิดชอบหรือผู้จัดการโครงการ)',
  })
  @Post(':id/plan/tasks/:taskId/reports')
  @Permissions('notification.read')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  })
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_UPDATE, {
      limits: { fileSize: MAX_TASK_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  reportTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskReportDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.work.report(id, taskId, body, files ?? [], principal);
  }

  @ApiOperation({ summary: 'ไฟล์ของงาน' })
  @Get(':id/plan/tasks/:taskId/files/:fileId')
  @Permissions('notification.read')
  async taskFile(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.work.download(id, taskId, fileId, principal);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }
}

/** CD-181 — งานของฉัน: the tasks handed to me, across projects. */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-tasks')
export class ProjectTasksController {
  constructor(private readonly work: TaskWorkService) {}

  @ApiOperation({ summary: 'งานในโครงการที่ฉันรับผิดชอบ (ยังไม่เสร็จ)' })
  @Get('mine')
  @Permissions('notification.read')
  mine(@CurrentPrincipal() principal: Principal) {
    return this.work.mine(principal);
  }
}

/** CD-183 — the risks the executives should see, across projects. */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-risks')
export class ProjectRisksController {
  constructor(private readonly risks: ProjectRisksService) {}

  @ApiOperation({
    summary: 'ความเสี่ยงสูงที่ยังไม่มีแผนรับมือ และที่เลยรอบทบทวน ในทุกโครงการ',
  })
  @Get('attention')
  @Permissions('pm.project.read')
  attention(@CurrentPrincipal() principal: Principal) {
    return this.risks.attention(principal);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-portfolio')
export class ProjectPortfolioController {
  constructor(private readonly statusReports: StatusReportsService) {}

  @ApiOperation({
    summary:
      'ภาพรวมโครงการที่ดำเนินอยู่ เรียงโครงการที่เสี่ยงเกินเกณฑ์ขึ้นก่อน (CD-192)',
  })
  @Get()
  @Permissions('notification.read')
  portfolio(@CurrentPrincipal() principal: Principal) {
    return this.statusReports.portfolio(principal);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-releases')
export class ProjectReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @ApiOperation({
    summary:
      'CD-214 — เวอร์ชันที่ลูกค้ารายนี้ใช้อยู่ในแต่ละโครงการ (เฉพาะโครงการที่ผู้ใช้เห็น)',
  })
  @Get()
  @Permissions('notification.read')
  forCustomer(
    @Query('customer_id') customerId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (!customerId) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุลูกค้า', [
        { field: 'customer_id', reason: 'required' },
      ]);
    }
    return this.releases.forCustomer(customerId, principal);
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-configs')
export class ProjectConfigsController {
  constructor(private readonly configs: ConfigsService) {}

  @ApiOperation({
    summary:
      'CD-217 — ค้นหาค่าตั้งค่าข้ามโครงการที่ผู้ใช้เห็น (ไม่ค้นในค่าลับ)',
  })
  @Get()
  @Permissions('notification.read')
  search(
    @Query('q') q: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.search(principal, q ?? '');
  }
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('project-resources')
export class ProjectWorkloadController {
  constructor(private readonly resources: ResourcesService) {}

  @ApiOperation({
    summary:
      'CD-180 — ภาระงานทีมรายสัปดาห์ข้ามโครงการ (เห็นตามสิทธิ์ของความพร้อมทีม CD-232)',
  })
  @Get('workload')
  @Permissions('notification.read')
  workload(
    @Query() query: WorkloadQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.resources.workload(principal, query);
  }
}
