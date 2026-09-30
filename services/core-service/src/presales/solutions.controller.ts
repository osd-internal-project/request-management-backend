import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  SaveLaborDto,
  SavePartnerQuoteDto,
  VendorQuoteRequestDto,
  BulkTorClausesDto,
  CreateTorClauseDto,
  SaveTorDto,
  UpdateTorClauseDto,
  AddEquipmentDto,
  AddFindingDto,
  CloseDemoDto,
  CreateDemoDto,
  ReturnEquipmentDto,
  UpdateDemoDto,
  CreateRiskDto,
  UpdateRiskDto,
  AnswerClarificationDto,
  CreateClarificationDto,
  ResolveClarificationDto,
  UpdateClarificationDto,
  AnswerRequirementDto,
  CreateRequirementDto,
  NewSolutionVersionDto,
  StartSolutionDto,
  UpdateRequirementDto,
  UpdateSolutionDraftDto,
} from './dto/solution.dto';
import { RequirementsService } from './requirements.service';
import { SolutionApprovalService } from './solution-approval.service';
import { ClarificationsService } from './clarifications.service';
import { RisksService } from './risks.service';
import { DemosService } from './demos.service';
import { MAX_TOR_FILE_BYTES, TorService } from './tor.service';
import { CostService, MAX_QUOTE_FILE_BYTES } from './cost.service';
import { MAX_FILE_BYTES, SolutionsService } from './solutions.service';

/**
 * CD-132 — ออกแบบ Solution, for the screens only. A partner system has no
 * design to send, so external-service does not serve these.
 *
 * Reads are `@Authenticated()` and judged in the service: Pre-Sales sees
 * every Solution, a salesperson only the one on a deal they can see.
 */
@ApiTags('presales')
@ApiBearerAuth()
@Controller()
export class SolutionsController {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly requirements: RequirementsService,
    private readonly approvals: SolutionApprovalService,
    private readonly clarifications: ClarificationsService,
    private readonly risks: RisksService,
    private readonly demos: DemosService,
    private readonly tor: TorService,
    private readonly cost: CostService,
  ) {}

  @ApiOperation({ summary: 'เริ่ม Solution จากคำขอ "ขอ Solution" ที่รับแล้ว' })
  @Post('presales/solutions')
  @Permissions('presales.solution.manage')
  start(@Body() dto: StartSolutionDto, @CurrentPrincipal() actor: Principal) {
    return this.solutions.start(dto.request_id, actor);
  }

  @ApiOperation({ summary: 'คำขอนี้เริ่ม Solution ได้ไหม / มีแล้วหรือยัง' })
  @Get('presales/solutions/by-request/:requestId')
  @Permissions('presales.solution.manage')
  forRequest(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.forRequest(requestId, actor);
  }

  @ApiOperation({
    summary:
      'CD-133 สมมติฐานสำหรับคำขอสัญญา — จาก Solution เวอร์ชันที่อนุมัติล่าสุดของดีล (id หรือเลขดีล)',
  })
  @Get('opportunities/:ref/contract-assumptions')
  @Permissions('crm.sales.read')
  contractAssumptions(
    @Param('ref') ref: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.contractAssumptions(ref, actor);
  }

  @ApiOperation({ summary: 'Solution ของดีล' })
  @Get('opportunities/:id/solutions')
  @Permissions('crm.sales.read')
  forDeal(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.solutions.forDeal(id, actor);
  }

  @ApiOperation({ summary: 'Solution พร้อมเวอร์ชันล่าสุด' })
  @Get('presales/solutions/:id')
  @Authenticated()
  findOne(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.solutions.findOne(id, actor);
  }

  @ApiOperation({ summary: 'Solution ที่เวอร์ชันที่ระบุ' })
  @Get('presales/solutions/:id/versions/:no')
  @Authenticated()
  version(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.findOne(id, actor, no);
  }

  @ApiOperation({ summary: 'แก้ร่าง (เฉพาะเวอร์ชันที่ยังไม่ยืนยัน)' })
  @Patch('presales/solutions/:id/versions/:no')
  @Permissions('presales.solution.manage')
  updateDraft(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: UpdateSolutionDraftDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.updateDraft(id, no, dto, actor);
  }

  @ApiOperation({ summary: 'ยืนยันเวอร์ชัน — แก้ไม่ได้อีก' })
  @Post('presales/solutions/:id/versions/:no/lock')
  @Permissions('presales.solution.manage')
  lock(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.lock(id, no, actor);
  }

  @ApiOperation({
    summary: 'ขออนุมัติเวอร์ชันนี้ (สร้างร่างคำขอ "ขออนุมัติ Solution")',
  })
  @Post('presales/solutions/:id/versions/:no/approval')
  @Permissions('presales.solution.manage')
  requestApproval(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.approvals.requestApproval(id, no, actor);
  }

  @ApiOperation({ summary: 'เปิดเวอร์ชันใหม่จากเวอร์ชันที่ยืนยันแล้ว' })
  @Post('presales/solutions/:id/versions')
  @Permissions('presales.solution.manage')
  newVersion(
    @Param('id') id: string,
    @Body() dto: NewSolutionVersionDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.newVersion(id, dto, actor);
  }

  @ApiOperation({ summary: 'แนบไฟล์แบบกับร่าง (≤ 25 MB, ≤ 30 ไฟล์)' })
  @Post('presales/solutions/:id/versions/:no/files')
  @Permissions('presales.solution.manage')
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
      limits: { fileSize: MAX_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.uploadFile(id, no, file, actor);
  }

  @ApiOperation({ summary: 'ไฟล์แบบ' })
  @Get('presales/solutions/:id/files/:fileId')
  @Authenticated()
  async download(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ): Promise<StreamableFile> {
    const file = await this.solutions.downloadFile(id, fileId, actor);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'เอาไฟล์ออกจากร่าง' })
  @Delete('presales/solutions/:id/versions/:no/files/:fileId')
  @Permissions('presales.solution.manage')
  removeFile(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.solutions.removeFile(id, no, fileId, actor);
  }

  // --- CD-131 วิเคราะห์ความต้องการ ------------------------------------------------

  @ApiOperation({ summary: 'เพิ่มความต้องการ (ธุรกิจ/เทคนิค)' })
  @Post('presales/solutions/:id/requirements')
  @Permissions('presales.solution.manage')
  addRequirement(
    @Param('id') id: string,
    @Body() dto: CreateRequirementDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.requirements.add(id, dto, actor);
  }

  @ApiOperation({
    summary: 'แก้ข้อความ หรือประเมินว่าทำได้/ไม่ได้/ต้องถามลูกค้า',
  })
  @Patch('presales/solutions/:id/requirements/:requirementId')
  @Permissions('presales.solution.manage')
  updateRequirement(
    @Param('id') id: string,
    @Param('requirementId') requirementId: string,
    @Body() dto: UpdateRequirementDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.requirements.update(id, requirementId, dto, actor);
  }

  @ApiOperation({
    summary: 'บันทึกคำตอบของลูกค้า (Pre-Sales หรือฝ่ายขายของดีล)',
  })
  @Post('presales/solutions/:id/requirements/:requirementId/answer')
  @Authenticated()
  answerRequirement(
    @Param('id') id: string,
    @Param('requirementId') requirementId: string,
    @Body() dto: AnswerRequirementDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.requirements.answer(id, requirementId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาความต้องการออก' })
  @Delete('presales/solutions/:id/requirements/:requirementId')
  @Permissions('presales.solution.manage')
  removeRequirement(
    @Param('id') id: string,
    @Param('requirementId') requirementId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.requirements.remove(id, requirementId, actor);
  }

  // --- CD-140 ชี้แจงประเด็นเทคนิค --------------------------------------------------

  @ApiOperation({
    summary: 'เพิ่มคำถามทางเทคนิคถึงลูกค้า (Pre-Sales หรือฝ่ายขายของดีล)',
  })
  @Post('presales/solutions/:id/clarifications')
  @Authenticated()
  ask(
    @Param('id') id: string,
    @Body() dto: CreateClarificationDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.clarifications.ask(id, dto, actor);
  }

  @ApiOperation({ summary: 'แก้ถ้อยคำคำถาม (ก่อนได้คำตอบ)' })
  @Patch('presales/solutions/:id/clarifications/:clarificationId')
  @Authenticated()
  editClarification(
    @Param('id') id: string,
    @Param('clarificationId') clarificationId: string,
    @Body() dto: UpdateClarificationDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.clarifications.edit(id, clarificationId, dto, actor);
  }

  @ApiOperation({ summary: 'บันทึกคำตอบของลูกค้า พร้อมผู้ตอบและวันที่' })
  @Post('presales/solutions/:id/clarifications/:clarificationId/answer')
  @Authenticated()
  answerClarification(
    @Param('id') id: string,
    @Param('clarificationId') clarificationId: string,
    @Body() dto: AnswerClarificationDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.clarifications.answer(id, clarificationId, dto, actor);
  }

  @ApiOperation({
    summary: 'ปิดคำตอบที่กระทบขอบเขต ด้วยเวอร์ชันที่แก้ SOW แล้ว',
  })
  @Post('presales/solutions/:id/clarifications/:clarificationId/resolve')
  @Permissions('presales.solution.manage')
  resolveClarification(
    @Param('id') id: string,
    @Param('clarificationId') clarificationId: string,
    @Body() dto: ResolveClarificationDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.clarifications.resolveScope(id, clarificationId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาคำถามออก' })
  @Delete('presales/solutions/:id/clarifications/:clarificationId')
  @Permissions('presales.solution.manage')
  removeClarification(
    @Param('id') id: string,
    @Param('clarificationId') clarificationId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.clarifications.remove(id, clarificationId, actor);
  }

  // --- CD-141 ความเสี่ยงทางเทคนิค ---------------------------------------------------

  @ApiOperation({ summary: 'เพิ่มความเสี่ยง (โอกาสเกิด × ผลกระทบ 1–5)' })
  @Post('presales/solutions/:id/risks')
  @Permissions('presales.solution.manage')
  addRisk(
    @Param('id') id: string,
    @Body() dto: CreateRiskDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.risks.add(id, dto, actor);
  }

  @ApiOperation({ summary: 'แก้ความเสี่ยง แนวทางลด หรือสถานะ' })
  @Patch('presales/solutions/:id/risks/:riskId')
  @Permissions('presales.solution.manage')
  updateRisk(
    @Param('id') id: string,
    @Param('riskId') riskId: string,
    @Body() dto: UpdateRiskDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.risks.update(id, riskId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาความเสี่ยงออก' })
  @Delete('presales/solutions/:id/risks/:riskId')
  @Permissions('presales.solution.manage')
  removeRisk(
    @Param('id') id: string,
    @Param('riskId') riskId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.risks.remove(id, riskId, actor);
  }

  // --- CD-139 Demo / POC ----------------------------------------------------------

  @ApiOperation({ summary: 'คำขอ "ขอจัด Demo หรือ POC" ของดีลนี้' })
  @Get('presales/solutions/:id/demo-requests')
  @Authenticated()
  demoRequests(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.demos.requestsFor(id, actor);
  }

  @ApiOperation({ summary: 'เพิ่ม Demo/POC (จากคำขอ หรือกรอกเอง)' })
  @Post('presales/solutions/:id/demos')
  @Permissions('presales.solution.manage')
  createDemo(
    @Param('id') id: string,
    @Body() dto: CreateDemoDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.create(id, dto, actor);
  }

  @ApiOperation({ summary: 'แก้แผน คน เกณฑ์/ผล หรือสรุปผล' })
  @Patch('presales/solutions/:id/demos/:demoId')
  @Permissions('presales.solution.manage')
  updateDemo(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() dto: UpdateDemoDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.update(id, demoId, dto, actor);
  }

  @ApiOperation({
    summary: 'ปิด Demo/POC (จัดแล้ว/ยกเลิก) — ต้องคืนอุปกรณ์ครบ',
  })
  @Post('presales/solutions/:id/demos/:demoId/close')
  @Permissions('presales.solution.manage')
  closeDemo(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() dto: CloseDemoDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.close(id, demoId, dto, actor);
  }

  @ApiOperation({
    summary: 'เอา Demo/POC ออก (ระหว่างวางแผน ไม่มีอุปกรณ์ค้าง)',
  })
  @Delete('presales/solutions/:id/demos/:demoId')
  @Permissions('presales.solution.manage')
  removeDemo(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.remove(id, demoId, actor);
  }

  @ApiOperation({ summary: 'เบิกอุปกรณ์' })
  @Post('presales/solutions/:id/demos/:demoId/equipment')
  @Permissions('presales.solution.manage')
  checkOut(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() dto: AddEquipmentDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.checkOut(id, demoId, dto, actor);
  }

  @ApiOperation({ summary: 'คืนอุปกรณ์' })
  @Post('presales/solutions/:id/demos/:demoId/equipment/:itemId/return')
  @Permissions('presales.solution.manage')
  checkIn(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ReturnEquipmentDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.checkIn(id, demoId, itemId, dto, actor);
  }

  @ApiOperation({ summary: 'บันทึกข้อค้นพบ' })
  @Post('presales/solutions/:id/demos/:demoId/findings')
  @Permissions('presales.solution.manage')
  addFinding(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Body() dto: AddFindingDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.addFinding(id, demoId, dto, actor);
  }

  @ApiOperation({ summary: 'ปิดข้อค้นพบด้วยเวอร์ชันที่ปรับแล้ว' })
  @Post('presales/solutions/:id/demos/:demoId/findings/:findingId/resolve')
  @Permissions('presales.solution.manage')
  resolveFinding(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Param('findingId') findingId: string,
    @Body() dto: ResolveClarificationDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.resolveFinding(id, demoId, findingId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาข้อค้นพบออก' })
  @Delete('presales/solutions/:id/demos/:demoId/findings/:findingId')
  @Permissions('presales.solution.manage')
  removeFinding(
    @Param('id') id: string,
    @Param('demoId') demoId: string,
    @Param('findingId') findingId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.demos.removeFinding(id, demoId, findingId, actor);
  }

  // --- CD-138 TOR / RFP -----------------------------------------------------------

  @ApiOperation({
    summary:
      'บันทึกข้อมูลหลักของ TOR (ผู้ซื้อ เลขโครงการ กำหนดยื่น หลักประกันซอง)',
  })
  @Put('presales/solutions/:id/tor')
  @Permissions('presales.solution.manage')
  saveTor(
    @Param('id') id: string,
    @Body() dto: SaveTorDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.saveFacts(id, dto, actor);
  }

  @ApiOperation({ summary: 'แนบไฟล์ TOR / RFP ต้นฉบับ (≤ 50 MB, ≤ 30 ไฟล์)' })
  @Post('presales/solutions/:id/tor/files')
  @Permissions('presales.solution.manage')
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
      limits: { fileSize: MAX_TOR_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  uploadTorFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.uploadFile(id, file, actor);
  }

  @ApiOperation({ summary: 'ไฟล์ TOR' })
  @Get('presales/solutions/:id/tor/files/:fileId')
  @Authenticated()
  async downloadTorFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ): Promise<StreamableFile> {
    const file = await this.tor.downloadFile(id, fileId, actor);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'เอาไฟล์ TOR ออก' })
  @Delete('presales/solutions/:id/tor/files/:fileId')
  @Permissions('presales.solution.manage')
  removeTorFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.removeFile(id, fileId, actor);
  }

  @ApiOperation({ summary: 'เพิ่มข้อกำหนด' })
  @Post('presales/solutions/:id/tor/clauses')
  @Permissions('presales.solution.manage')
  addTorClause(
    @Param('id') id: string,
    @Body() dto: CreateTorClauseDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.addClause(id, dto, actor);
  }

  @ApiOperation({ summary: 'วางข้อกำหนดจาก TOR ทีละหลายข้อ (ข้อละบรรทัด)' })
  @Post('presales/solutions/:id/tor/clauses/bulk')
  @Permissions('presales.solution.manage')
  addTorClauses(
    @Param('id') id: string,
    @Body() dto: BulkTorClausesDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.addBulk(id, dto, actor);
  }

  @ApiOperation({ summary: 'แก้ข้อกำหนด หรือบันทึกการตอบ' })
  @Patch('presales/solutions/:id/tor/clauses/:clauseId')
  @Permissions('presales.solution.manage')
  updateTorClause(
    @Param('id') id: string,
    @Param('clauseId') clauseId: string,
    @Body() dto: UpdateTorClauseDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.updateClause(id, clauseId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาข้อกำหนดออก' })
  @Delete('presales/solutions/:id/tor/clauses/:clauseId')
  @Permissions('presales.solution.manage')
  removeTorClause(
    @Param('id') id: string,
    @Param('clauseId') clauseId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.tor.removeClause(id, clauseId, actor);
  }

  // --- CD-136 ประมาณต้นทุน --------------------------------------------------------

  @ApiOperation({
    summary: 'บันทึกต้นทุนแรงงาน (บทบาท × manday, อัตราจากตั้งค่า)',
  })
  @Put('presales/solutions/:id/versions/:no/labor')
  @Permissions('presales.solution.manage')
  saveLabor(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SaveLaborDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.saveLabor(id, no, dto, actor);
  }

  @ApiOperation({ summary: 'เพิ่มใบเสนอราคาจากคู่ค้า' })
  @Post('presales/solutions/:id/versions/:no/quotes')
  @Permissions('presales.solution.manage')
  addQuote(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SavePartnerQuoteDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.saveQuote(id, no, null, dto, actor);
  }

  @ApiOperation({ summary: 'แก้ใบเสนอราคาจากคู่ค้า' })
  @Put('presales/solutions/:id/versions/:no/quotes/:quoteId')
  @Permissions('presales.solution.manage')
  updateQuote(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Param('quoteId') quoteId: string,
    @Body() dto: SavePartnerQuoteDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.saveQuote(id, no, quoteId, dto, actor);
  }

  @ApiOperation({ summary: 'เอาใบเสนอราคาจากคู่ค้าออก' })
  @Delete('presales/solutions/:id/versions/:no/quotes/:quoteId')
  @Permissions('presales.solution.manage')
  removeQuote(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Param('quoteId') quoteId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.removeQuote(id, no, quoteId, actor);
  }

  @ApiOperation({ summary: 'แนบไฟล์ใบเสนอราคาคู่ค้า (≤ 25 MB)' })
  @Post('presales/solutions/:id/versions/:no/quotes/:quoteId/file')
  @Permissions('presales.solution.manage')
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
      limits: { fileSize: MAX_QUOTE_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  uploadQuoteFile(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Param('quoteId') quoteId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.uploadQuoteFile(id, no, quoteId, file, actor);
  }

  @ApiOperation({ summary: 'ไฟล์ใบเสนอราคาคู่ค้า' })
  @Get('presales/solutions/:id/quotes/:quoteId/file')
  @Authenticated()
  async downloadQuoteFile(
    @Param('id') id: string,
    @Param('quoteId') quoteId: string,
    @CurrentPrincipal() actor: Principal,
  ): Promise<StreamableFile> {
    const file = await this.cost.downloadQuoteFile(id, quoteId, actor);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({
    summary: 'ขอราคาจากคู่ค้าสำหรับบรรทัด BOQ ที่เลือก (สร้างร่างคำขอ)',
  })
  @Post('presales/solutions/:id/versions/:no/vendor-quote-request')
  @Permissions('presales.solution.manage')
  requestVendorQuote(
    @Param('id') id: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: VendorQuoteRequestDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.cost.requestVendorQuote(id, no, dto, actor);
  }
}
