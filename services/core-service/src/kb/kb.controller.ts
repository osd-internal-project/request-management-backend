import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
  KbProductsQueryDto,
  RateKbArticleDto,
  SaveKbArticleDto,
  SaveKbCategoryDto,
  SearchKbArticlesQueryDto,
} from './kb.dto';
import { MAX_FILE_BYTES } from './kb-rules';
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
  constructor(private readonly kb: KbService) {}

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

  @ApiOperation({ summary: 'CD-259 เผยแพร่ (ผู้ดูแลคลังความรู้)' })
  @Post('articles/:id/publish')
  @AnyPermission('kb.article.manage')
  publish(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.kb.publish(principal, id);
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
    summary: 'CD-259 กลับเป็นฉบับร่างเพื่อแก้ (ผู้ดูแลคลังความรู้)',
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
