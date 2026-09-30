import {
  Body,
  Controller,
  Get,
  Headers,
  Put,
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
import { ContractRiskService } from './contract-risk.service';
import { ContractDraftApprovalService } from './contract-draft-approval.service';
import { ContractRequestPackageService } from './contract-request-package.service';
import {
  AnswerReviewCommentDto,
  CompareVersionsQueryDto,
  OpenReviewRoundDto,
  ReviewCommentDto,
  SaveRiskAssessmentDto,
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
    private readonly risk: ContractRiskService,
    private readonly approval: ContractDraftApprovalService,
    private readonly packages: ContractRequestPackageService,
  ) {}

  @ApiOperation({
    summary: 'ข้อมูลการค้าและขอบเขตงานที่มากับคำขอจัดทำสัญญา (CD-145)',
    description:
      'เก็บตอนยื่นคำขอ: เงื่อนไขรอบต่อรองล่าสุด + ขอบเขตงาน/รายการส่งมอบ/สมมติฐานของ Solution ที่อนุมัติ',
  })
  @Get('contract-requests/:requestId/package')
  @Permissions('legal.contract.read')
  viewPackage(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.packages.view(requestId, principal);
  }

  @ApiOperation({ summary: 'ดึงข้อมูลการค้าและขอบเขตงานจากดีลอีกครั้ง' })
  @Post('contract-requests/:requestId/package/refresh')
  @Permissions('legal.contract.manage')
  refreshPackage(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.packages.refresh(requestId, principal);
  }

  @ApiOperation({
    summary: 'ประเมินความเสี่ยงของร่าง (CD-158 บนร่าง, CD-159)',
    description: 'ปิดคำขอแล้ว การประเมินย้ายไปอยู่กับสัญญาที่เกิดจากคำขอ',
  })
  @Get('contract-drafts/:id/risk')
  @Permissions('legal.contract.read')
  viewRisk(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.risk.view({ draftId: id }, principal);
  }

  @ApiOperation({ summary: 'บันทึกการประเมินความเสี่ยงของร่าง' })
  @Put('contract-drafts/:id/risk')
  @Permissions('legal.contract.manage')
  saveRisk(
    @Param('id') id: string,
    @Body() dto: SaveRiskAssessmentDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.risk.save({ draftId: id }, dto, principal, authorization);
  }

  @ApiOperation({
    summary: 'ขอความเห็นผู้บริหารเรื่องความเสี่ยงของร่างอีกครั้ง',
  })
  @Post('contract-drafts/:id/risk/opinion')
  @Permissions('legal.contract.manage')
  requestRiskOpinion(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.risk.requestOpinion({ draftId: id }, principal, authorization);
  }

  @ApiOperation({
    summary: 'การอนุมัติร่าง (CD-159)',
    description:
      '`blockers` = เหตุที่ยังขออนุมัติไม่ได้ · `approvedVersionNo` = ฉบับที่อนุมัติแล้ว · แก้ร่างหลังขออนุมัติ = การอนุมัติเป็นโมฆะ',
  })
  @Get('contract-drafts/:id/approval')
  @Permissions('legal.contract.read')
  viewApproval(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.approval.view(id, principal);
  }

  @ApiOperation({
    summary: 'ขออนุมัติร่างฉบับล่าสุด',
    description:
      'ยื่นคำขอประเภทที่ตั้งในหน้าตั้งค่า CRM — form มี contract_value และ risk_level ให้ตารางอำนาจอนุมัติตั้งเงื่อนไขได้ · ต้องไม่มีรอบตรวจค้าง และความเสี่ยงผ่าน',
  })
  @Post('contract-drafts/:id/approval')
  @Permissions('legal.contract.manage')
  requestApproval(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.approval.request(id, principal, authorization);
  }

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
