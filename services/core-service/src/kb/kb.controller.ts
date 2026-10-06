import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
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
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ArchiveKbArticleDto,
  KbArticleUseDto,
  KbConfirmReviewDto,
  KbGapAssignDto,
  KbGapDismissDto,
  KbGapLinkDto,
  KbGapsQueryDto,
  KbDraftFromJobsDto,
  KbInboxQueryDto,
  KbSkipJobsDto,
  KbWithdrawFromCustomersDto,
  KbMergeDto,
  KbOwnerDto,
  KbReviewDecisionDto,
  SaveKbRevisionDto,
  KbProductsQueryDto,
  RateKbArticleDto,
  SaveKbArticleDto,
  SaveKbCategoryDto,
  SearchKbArticlesQueryDto,
} from './kb.dto';
import { MAX_FILE_BYTES } from './kb-rules';
import { KbAiLogQueryDto } from './kb-ai.dto';
import { KbAiService } from './kb-ai.service';
import { KbFieldService } from './kb-field.service';
import { KbGapService } from './kb-gap.service';
import { KbLessonService } from './kb-lesson.service';
import { KbReviewService } from './kb-review.service';
import { KbService, type SaveArticle } from './kb.service';

const toInput = (dto: SaveKbArticleDto): SaveArticle => ({
  title: dto.title,
  summary: dto.summary,
  body: dto.body,
  categoryId: dto.category_id,
  tags: dto.tags,
  productCodes: dto.product_codes,
  productGroups: dto.product_groups,
  audience: dto.audience,
  customerIds: dto.customer_ids,
});

/** CD-22 KBMS — คลังความรู้ (CD-259 คลังบทความ). */
@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb')
export class KbController {
  constructor(
    private readonly kb: KbService,
    private readonly review: KbReviewService,
    private readonly field: KbFieldService,
    private readonly lessons: KbLessonService,
    private readonly ai: KbAiService,
    private readonly gaps: KbGapService,
  ) {}

  // --- CD-266 ช่องว่างความรู้ ---------------------------------------------------------

  @ApiOperation({
    summary:
      'CD-266 ช่องว่างความรู้ (AI ตอบไม่ได้ · คะแนนต่ำ · ค้นไม่เจอ) — ผู้ดูแลเห็นทั้งหมด คนอื่นเห็นที่มอบให้ตัวเอง',
  })
  @Get('gaps')
  @Authenticated()
  gapList(
    @Query() query: KbGapsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.gaps.list(principal, {
      status: query.status,
      kind: query.kind,
      mine: query.mine === 'true',
    });
  }

  @ApiOperation({
    summary:
      'CD-266 อัตราตอบได้เองของ AI และช่องว่างเปิด/ปิด รายเดือน (12 เดือน)',
  })
  @Get('gaps/monthly')
  @AnyPermission('kb.article.manage')
  gapMonthly(@CurrentPrincipal() principal: Principal) {
    return this.gaps.monthly(principal);
  }

  @ApiOperation({
    summary: 'CD-266 มอบหมายผู้เติมพร้อมกำหนดส่ง — ผู้ดูแลคลังความรู้',
  })
  @Post('gaps/:id/assign')
  @AnyPermission('kb.article.manage')
  gapAssign(
    @Param('id') id: string,
    @Body() dto: KbGapAssignDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.gaps.assign(principal, id, dto.assignee_id, dto.due_on);
  }

  @ApiOperation({
    summary: 'CD-266 เริ่มเขียนบทความจากช่องว่าง (ฉบับร่างของผู้เติม)',
  })
  @Post('gaps/:id/article')
  @Authenticated()
  gapArticle(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.gaps.startArticle(principal, id);
  }

  @ApiOperation({
    summary: 'CD-266 เติมด้วยบทความที่มีอยู่ (ปิดเมื่อบทความเผยแพร่)',
  })
  @Post('gaps/:id/link')
  @Authenticated()
  gapLink(
    @Param('id') id: string,
    @Body() dto: KbGapLinkDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.gaps.link(principal, id, dto.article_id);
  }

  @ApiOperation({ summary: 'CD-266 ปิดทิ้งพร้อมเหตุผล — ผู้ดูแลคลังความรู้' })
  @Post('gaps/:id/dismiss')
  @AnyPermission('kb.article.manage')
  gapDismiss(
    @Param('id') id: string,
    @Body() dto: KbGapDismissDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.gaps.dismiss(principal, id, dto.reason);
  }

  @ApiOperation({
    summary:
      'CD-265 บันทึกคำถามที่ AI ค้นคลังความรู้ บทความที่ได้ และคำตอบที่อ้างอิง — ผู้ดูแลคลังความรู้',
  })
  @Get('ai-log')
  @AnyPermission('kb.article.manage')
  aiLog(
    @Query() query: KbAiLogQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.ai.log(principal, {
      outcome: query.outcome,
      channel: query.channel,
      articleId: query.article_id,
    });
  }

  @ApiOperation({
    summary:
      'CD-263 ส่งบทเรียนของโครงการเข้าคลังความรู้ (เป็นฉบับร่างของผู้จัดการโครงการ) — ไม่ต้องรอปิดโครงการ',
  })
  @Post('projects/:projectId/lessons/send')
  @Authenticated()
  sendLessons(
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.lessons.send(principal, projectId);
  }

  // --- CD-262 ความรู้จากงานบริการที่ปิดและปัญหาราก ------------------------------------

  @ApiOperation({
    summary:
      'CD-262 กล่องความรู้จากหน้างาน (ใบงานบริการที่ปิด) — ทีมบริการ/ผู้ดูแลคลังความรู้',
  })
  @Get('field-inbox')
  @AnyPermission(
    'kb.article.manage',
    'service.asset.manage',
    'presales.solution.manage',
  )
  fieldInbox(
    @Query() query: KbInboxQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.field.inbox(principal, query.status);
  }

  @ApiOperation({ summary: 'CD-262 รวมใบงานที่เลือกเป็นฉบับร่างบทความ' })
  @Post('field-inbox/draft')
  @AnyPermission(
    'kb.article.manage',
    'service.asset.manage',
    'presales.solution.manage',
  )
  draftFromJobs(
    @Body() dto: KbDraftFromJobsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.field.draftFrom(principal, dto.ids, dto.title);
  }

  @ApiOperation({ summary: 'CD-262 ข้ามใบงานที่ไม่ควรเป็นบทความ' })
  @Post('field-inbox/skip')
  @AnyPermission(
    'kb.article.manage',
    'service.asset.manage',
    'presales.solution.manage',
  )
  skipJobs(
    @Body() dto: KbSkipJobsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.field.skip(principal, dto.ids, dto.reason);
  }

  @ApiOperation({
    summary: 'CD-262 บทความแนะนำสำหรับใบงานบริการ และที่ใช้แก้แล้ว',
  })
  @Get('work-orders/:workOrderId/suggestions')
  @Authenticated()
  suggestions(
    @Param('workOrderId') workOrderId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.field.suggest(principal, workOrderId);
  }

  @ApiOperation({
    summary: 'CD-262 บันทึกว่าใช้บทความนี้แก้ใบงาน (หรือเอาออก)',
  })
  @Post('work-orders/:workOrderId/uses')
  @Authenticated()
  markUsed(
    @Param('workOrderId') workOrderId: string,
    @Body() dto: KbArticleUseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.field.markUsed(
      principal,
      workOrderId,
      dto.article_id,
      dto.used,
    );
  }

  @ApiOperation({
    summary: 'CD-262 ที่มาของบทความ (ใบงาน/ปัญหาราก) และจำนวนครั้งที่ใช้แก้งาน',
  })
  @Get('articles/:id/provenance')
  @Authenticated()
  async provenance(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.kb.findOne(principal, id, false);
    const [origin, aiCitations] = await Promise.all([
      this.field.provenance(id),
      this.ai.citationCount(id),
    ]);
    // CD-265 — how often AI answers cited it
    return { ...origin, aiCitations };
  }

  // --- CD-260 กลั่นกรองและอนุมัติ ---------------------------------------------------

  @ApiOperation({
    summary: 'CD-260 งานรอตรวจ (ผู้ดูแล) และบทความที่ใกล้/เลยรอบทบทวน',
  })
  @Get('review-queue')
  @Authenticated()
  reviewQueue(@CurrentPrincipal() principal: Principal) {
    return this.review.queue(principal);
  }

  @ApiOperation({ summary: 'CD-260 ส่งฉบับร่างแรกให้ตรวจ' })
  @Post('articles/:id/submit')
  @Authenticated()
  submit(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.review.submit(principal, id);
  }

  @ApiOperation({
    summary: 'CD-260 ดึงกลับจากการรอตรวจเพื่อแก้ (ฉบับร่าง หรือฉบับปรับปรุง)',
  })
  @Post('articles/:id/withdraw')
  @Authenticated()
  withdraw(
    @Param('id') id: string,
    @Body() dto: KbReviewDecisionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.withdraw(principal, id, dto.revision_id);
  }

  @ApiOperation({
    summary:
      'CD-260 อนุมัติเผยแพร่ (ฉบับร่างแรก หรือฉบับปรับปรุง) — ผู้ดูแลคลังความรู้',
  })
  @Post('articles/:id/approve')
  @AnyPermission('kb.article.manage')
  approve(
    @Param('id') id: string,
    @Body() dto: KbReviewDecisionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.approve(principal, id, dto.revision_id, dto.note);
  }

  @ApiOperation({
    summary: 'CD-260 ตีกลับพร้อมสิ่งที่ต้องแก้ — ผู้ดูแลคลังความรู้',
  })
  @Post('articles/:id/send-back')
  @AnyPermission('kb.article.manage')
  sendBack(
    @Param('id') id: string,
    @Body() dto: KbReviewDecisionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.sendBack(principal, id, dto.note ?? '', dto.revision_id);
  }

  @ApiOperation({ summary: 'CD-260 เปิดฉบับปรับปรุงของบทความที่เผยแพร่อยู่' })
  @Post('articles/:id/revisions')
  @Authenticated()
  openRevision(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.openRevision(principal, id);
  }

  @ApiOperation({ summary: 'CD-260 ฉบับปรับปรุง' })
  @Get('articles/:id/revisions/:revisionId')
  @Authenticated()
  revision(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.revisionView(principal, id, revisionId);
  }

  @ApiOperation({ summary: 'CD-260 แก้ฉบับปรับปรุง' })
  @Put('articles/:id/revisions/:revisionId')
  @Authenticated()
  updateRevision(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() dto: SaveKbRevisionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.updateRevision(principal, id, revisionId, {
      ...toInput(dto),
      changeNote: dto.change_note,
    });
  }

  @ApiOperation({ summary: 'CD-260 ส่งฉบับปรับปรุงให้ตรวจ' })
  @Post('articles/:id/revisions/:revisionId/submit')
  @Authenticated()
  submitRevision(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.submitRevision(principal, id, revisionId);
  }

  @ApiOperation({ summary: 'CD-260 ทิ้งฉบับปรับปรุง' })
  @Delete('articles/:id/revisions/:revisionId')
  @Authenticated()
  discardRevision(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.discardRevision(principal, id, revisionId);
  }

  @ApiOperation({ summary: 'CD-260 ประวัติเวอร์ชันที่เผยแพร่' })
  @Get('articles/:id/versions')
  @Authenticated()
  versions(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.review.versions(principal, id);
  }

  @ApiOperation({ summary: 'CD-260 เนื้อหาของเวอร์ชันหนึ่ง (ไว้เทียบ)' })
  @Get('articles/:id/versions/:version')
  @Authenticated()
  version(
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.version(principal, id, version);
  }

  @ApiOperation({ summary: 'CD-260 เปลี่ยนเจ้าของบทความ' })
  @Put('articles/:id/owner')
  @Authenticated()
  setOwner(
    @Param('id') id: string,
    @Body() dto: KbOwnerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.setOwner(principal, id, dto.user_id);
  }

  @ApiOperation({
    summary: 'CD-260 ทบทวนแล้ว เนื้อหายังถูกต้อง (เจ้าของ/ผู้ดูแล)',
  })
  @Post('articles/:id/reviewed')
  @Authenticated()
  confirmReview(
    @Param('id') id: string,
    @Body() dto: KbConfirmReviewDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.confirmReview(principal, id, dto.note);
  }

  @ApiOperation({
    summary:
      'CD-261 ถอนบทความออกจาก Portal ลูกค้าทันที (เป็นภายใน) — ผู้ดูแลคลังความรู้',
  })
  @Post('articles/:id/withdraw-from-customers')
  @AnyPermission('kb.article.manage')
  withdrawFromCustomers(
    @Param('id') id: string,
    @Body() dto: KbWithdrawFromCustomersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.withdrawFromCustomers(principal, id, dto.reason);
  }

  @ApiOperation({
    summary: 'CD-260 รวมบทความซ้ำเข้าบทความหลัก — ผู้ดูแลคลังความรู้',
  })
  @Post('articles/:id/merge')
  @AnyPermission('kb.article.manage')
  merge(
    @Param('id') id: string,
    @Body() dto: KbMergeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.review.merge(principal, id, dto.into_id);
  }

  @ApiOperation({ summary: 'CD-259 ค้นบทความ (คำค้น หมวด สินค้า แท็ก สถานะ)' })
  @Get('articles')
  @Authenticated()
  async search(
    @Query() query: SearchKbArticlesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.kb.search(principal, {
      q: query.q,
      status: query.status,
      categoryId: query.category_id,
      productCode: query.product_code,
      tag: query.tag,
      audience: query.audience,
      limit: query.limit,
    });
    // CD-266 — a plain keyword search of published articles that found nothing
    const plain =
      !query.status &&
      !query.category_id &&
      !query.product_code &&
      !query.tag &&
      !query.audience;
    if (plain && query.q?.trim() && !result.items.length) {
      await this.gaps.recordSearchMiss(principal.activeCompanyId, query.q);
    }
    return result;
  }

  @ApiOperation({ summary: 'CD-259 เขียนบทความใหม่ (ฉบับร่าง)' })
  @Post('articles')
  @Authenticated()
  create(
    @Body() dto: SaveKbArticleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.create(principal, toInput(dto));
  }

  @ApiOperation({ summary: 'CD-259 แท็กที่ใช้อยู่ (มากไปน้อย)' })
  @Get('tags')
  @Authenticated()
  tags(@CurrentPrincipal() principal: Principal) {
    return this.kb.tags(principal);
  }

  @ApiOperation({ summary: 'CD-259 สินค้าและกลุ่มสินค้า SAP ให้ผูกกับบทความ' })
  @Get('products')
  @Authenticated()
  products(
    @Query() query: KbProductsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.products(principal, query.q);
  }

  @ApiOperation({ summary: 'CD-259 หมวดกระบวนการ' })
  @Get('categories')
  @Authenticated()
  categories(@CurrentPrincipal() principal: Principal) {
    return this.kb.categories(principal);
  }

  @ApiOperation({ summary: 'CD-259 เพิ่มหมวด (ผู้ดูแลคลังความรู้)' })
  @Post('categories')
  @AnyPermission('kb.article.manage')
  createCategory(
    @Body() dto: SaveKbCategoryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.saveCategory(principal, null, {
      name: dto.name,
      parentId: dto.parent_id,
      sortOrder: dto.sort_order,
      active: dto.active,
      reviewMonths: dto.review_months,
    });
  }

  @ApiOperation({ summary: 'CD-259 แก้หมวด (ผู้ดูแลคลังความรู้)' })
  @Put('categories/:id')
  @AnyPermission('kb.article.manage')
  updateCategory(
    @Param('id') id: string,
    @Body() dto: SaveKbCategoryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.saveCategory(principal, id, {
      name: dto.name,
      parentId: dto.parent_id,
      sortOrder: dto.sort_order,
      active: dto.active,
      reviewMonths: dto.review_months,
    });
  }

  @ApiOperation({ summary: 'CD-259 อ่านบทความ' })
  @Get('articles/:id')
  @Authenticated()
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.kb.findOne(principal, id);
  }

  @ApiOperation({
    summary: 'CD-259 แก้บทความ (ผู้เขียนขณะร่าง / ผู้ดูแลคลังความรู้)',
  })
  @Put('articles/:id')
  @Authenticated()
  update(
    @Param('id') id: string,
    @Body() dto: SaveKbArticleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.update(principal, id, toInput(dto));
  }

  @ApiOperation({ summary: 'CD-259 ลบฉบับร่างที่ไม่เคยเผยแพร่' })
  @Delete('articles/:id')
  @Authenticated()
  remove(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.kb.remove(principal, id);
  }

  @ApiOperation({ summary: 'CD-259 เลิกใช้ (ผู้ดูแลคลังความรู้)' })
  @Post('articles/:id/archive')
  @AnyPermission('kb.article.manage')
  archive(
    @Param('id') id: string,
    @Body() dto: ArchiveKbArticleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.archive(principal, id, dto.reason);
  }

  @ApiOperation({
    summary:
      'CD-259/260 นำบทความที่เลิกใช้กลับเป็นฉบับร่าง (ผู้ดูแลคลังความรู้)',
  })
  @Post('articles/:id/reopen')
  @AnyPermission('kb.article.manage')
  reopen(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.kb.reopen(principal, id);
  }

  @ApiOperation({ summary: 'CD-259 ให้คะแนนว่ามีประโยชน์หรือไม่' })
  @Post('articles/:id/rate')
  @Authenticated()
  rate(
    @Param('id') id: string,
    @Body() dto: RateKbArticleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.rate(principal, id, dto.helpful, dto.comment);
  }

  @ApiOperation({ summary: 'CD-259 ความเห็นของผู้อ่าน (ผู้เขียน/ผู้ดูแล)' })
  @Get('articles/:id/ratings')
  @Authenticated()
  ratings(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.kb.ratings(principal, id);
  }

  @ApiOperation({ summary: 'CD-259 แนบรูป/ไฟล์ในบทความ' })
  @Post('articles/:id/files')
  @Authenticated()
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
  attach(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.attach(principal, id, file);
  }

  @ApiOperation({ summary: 'CD-259 ไฟล์ในบทความ' })
  @Get('articles/:id/files/:fileId')
  @Authenticated()
  async file(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.kb.file(principal, id, fileId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'CD-259 ลบไฟล์ในบทความ' })
  @Delete('articles/:id/files/:fileId')
  @Authenticated()
  removeFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.removeFile(principal, id, fileId);
  }
}
