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
  KbConfirmReviewDto,
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
});

/** CD-22 KBMS — คลังความรู้ (CD-259 คลังบทความ). */
@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb')
export class KbController {
  constructor(
    private readonly kb: KbService,
    private readonly review: KbReviewService,
  ) {}

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
  search(
    @Query() query: SearchKbArticlesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kb.search(principal, {
      q: query.q,
      status: query.status,
      categoryId: query.category_id,
      productCode: query.product_code,
      tag: query.tag,
      limit: query.limit,
    });
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
