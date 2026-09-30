import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractTemplatesService } from './contract-templates.service';
import { ContractReviewsService } from './contract-reviews.service';
import {
  AnswerReviewCommentDto,
  CompareVersionsQueryDto,
  OpenReviewRoundDto,
  ReviewCommentDto,
  DraftVersionQueryDto,
  SaveContractTemplateDto,
  SaveDraftVersionDto,
  StartContractDraftDto,
} from './dto/legal-contract.dto';

/**
 * CD-146 แม่แบบและร่างสัญญา — the Legal screens only. Not generated and not
 * on external-service: no integration drafts contracts.
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller()
export class ContractDraftsController {
  constructor(
    private readonly templates: ContractTemplatesService,
    private readonly drafts: ContractDraftsService,
    private readonly reviews: ContractReviewsService,
  ) {}

  @ApiOperation({ summary: 'เปรียบเทียบร่างสองฉบับ รายข้อ (CD-147)' })
  @Get('contract-drafts/:id/compare')
  @Permissions('legal.contract.read')
  compare(
    @Param('id') id: string,
    @Query() query: CompareVersionsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.compare(id, query.from, query.to, principal);
  }

  @ApiOperation({
    summary: 'รอบตรวจของร่าง พร้อมความเห็นรายข้อ',
    description: '`changedSince` = ข้อนั้นถูกแก้แล้วนับจากฉบับที่ตรวจ',
  })
  @Get('contract-drafts/:id/reviews')
  @Permissions('legal.contract.read')
  listReviews(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.list(id, principal);
  }

  @ApiOperation({ summary: 'เปิดรอบตรวจบนฉบับล่าสุด — เปิดได้ครั้งละรอบ' })
  @Post('contract-drafts/:id/reviews')
  @Permissions('legal.contract.manage')
  openReview(
    @Param('id') id: string,
    @Body() dto: OpenReviewRoundDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.open(id, dto, principal);
  }

  @ApiOperation({ summary: 'ให้ความเห็นรายข้อ' })
  @Post('contract-reviews/:roundId/comments')
  @Permissions('legal.contract.manage')
  comment(
    @Param('roundId') roundId: string,
    @Body() dto: ReviewCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.comment(roundId, dto, principal);
  }

  @ApiOperation({ summary: 'ปิดรอบตรวจ — ต้องตอบความเห็นครบทุกข้อ' })
  @Post('contract-reviews/:roundId/close')
  @Permissions('legal.contract.manage')
  closeReview(
    @Param('roundId') roundId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.close(roundId, principal);
  }

  @ApiOperation({ summary: 'ตอบความเห็น — แก้แล้ว หรือ ไม่แก้ (พร้อมเหตุผล)' })
  @Post('contract-review-comments/:id/answer')
  @Permissions('legal.contract.manage')
  answer(
    @Param('id') id: string,
    @Body() dto: AnswerReviewCommentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reviews.answer(id, dto, principal);
  }

  @ApiOperation({ summary: 'ตัวแปรที่แม่แบบใช้ได้' })
  @Get('contract-templates/variables')
  @Permissions('legal.contract.read')
  variables() {
    return this.templates.variables();
  }

  @ApiOperation({ summary: 'แม่แบบสัญญา' })
  @Get('contract-templates')
  @Permissions('legal.contract.read')
  listTemplates(
    @Query('include_inactive') includeInactive: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.templates.list(principal, includeInactive === 'true');
  }

  @ApiOperation({ summary: 'สร้างแม่แบบสัญญา' })
  @Post('contract-templates')
  @Permissions('legal.contract.manage')
  createTemplate(
    @Body() dto: SaveContractTemplateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.templates.create(dto, principal);
  }

  @ApiOperation({
    summary: 'แก้แม่แบบสัญญา — ไม่กระทบร่างที่เริ่มไปแล้ว',
  })
  @Patch('contract-templates/:id')
  @Permissions('legal.contract.manage')
  updateTemplate(
    @Param('id') id: string,
    @Body() dto: SaveContractTemplateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.templates.update(id, dto, principal);
  }

  @ApiOperation({
    summary: 'ร่างสัญญาของคำขอ',
    description:
      '`eligible` = คำขอเป็นประเภทคำขอจัดทำสัญญาที่ตั้งในหน้าตั้งค่า CRM · ยังไม่มีร่างจะส่งรายการแม่แบบมาให้เลือก',
  })
  @Get('contract-drafts/by-request/:requestId')
  @Permissions('legal.contract.read')
  forRequest(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.drafts.forRequest(requestId, principal);
  }

  @ApiOperation({
    summary:
      'เริ่มร่างจากแม่แบบ — เติมค่าจากคำขอ ดีล ลูกค้า เงื่อนไขที่ต่อรอง และหัวกระดาษ',
  })
  @Post('contract-drafts')
  @Permissions('legal.contract.manage')
  start(
    @Body() dto: StartContractDraftDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.drafts.start(dto, principal);
  }

  @ApiOperation({
    summary: 'ร่างฉบับหนึ่ง — ทำเครื่องหมายข้อที่แก้/เพิ่ม/ตัดจากแม่แบบ',
  })
  @Get('contract-drafts/:id')
  @Permissions('legal.contract.read')
  view(
    @Param('id') id: string,
    @Query() query: DraftVersionQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.drafts.view(id, principal, query.version);
  }

  @ApiOperation({
    summary: 'บันทึกเป็นฉบับใหม่',
    description:
      'ฉบับเดิมไม่ถูกแก้ · มีผู้บันทึกฉบับใหม่กว่าหรือข้อความไม่เปลี่ยนตอบ 409',
  })
  @Post('contract-drafts/:id/versions')
  @Permissions('legal.contract.manage')
  saveVersion(
    @Param('id') id: string,
    @Body() dto: SaveDraftVersionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.drafts.saveVersion(id, dto, principal);
  }
}
