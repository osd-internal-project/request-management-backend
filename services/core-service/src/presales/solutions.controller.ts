import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
  AnswerRequirementDto,
  CreateRequirementDto,
  NewSolutionVersionDto,
  StartSolutionDto,
  UpdateRequirementDto,
  UpdateSolutionDraftDto,
} from './dto/solution.dto';
import { RequirementsService } from './requirements.service';
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
}
