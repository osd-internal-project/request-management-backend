import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
import {
  AnyPermission,
  Authenticated,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { CampaignPlanService } from './campaign-plan.service';
import { CampaignReceiptsService } from './campaign-receipts.service';
import { CampaignEventsService } from '../crm/campaign-events.service';
import { ContentService } from './content.service';
import { ContentApprovalService } from './content-approval.service';
import { BrandService } from './brand.service';
import { BrandFilesService } from './brand-files.service';
import { MAX_BRAND_FILE_BYTES, inlineSafe } from './brand-rules';
import {
  ContentFilesService,
  MAX_CONTENT_MEDIA_BYTES,
} from './content-files.service';
import {
  CheckInDto,
  ConvertRegistrationsDto,
  FollowRegistrationDto,
  RegistrationStatusDto,
  WalkInDto,
} from '../crm/dto/sales.dto';
import {
  AddCampaignSpendDto,
  CopyContentDto,
  ListContentQueryDto,
  MoveContentDto,
  SaveContentDto,
  WithdrawContentDto,
  BrandVersionNoteDto,
  CreateBrandAssetDto,
  ListBrandAssetsQueryDto,
  RetireBrandAssetDto,
  UpdateBrandAssetDto,
  SaveBudgetLinesDto,
  VoidCampaignSpendDto,
} from './macom.dto';

/** CD-15 MACOM — การตลาดและสื่อสาร. */
@ApiTags('macom')
@ApiBearerAuth()
@Controller('macom')
export class MacomController {
  constructor(
    private readonly plans: CampaignPlanService,
    private readonly receipts: CampaignReceiptsService,
    private readonly events: CampaignEventsService,
    private readonly content: ContentService,
    private readonly contentFiles: ContentFilesService,
    private readonly contentApproval: ContentApprovalService,
    private readonly brand: BrandService,
    private readonly brandFiles: BrandFilesService,
  ) {}

  // --- CD-273 คลังแบรนด์และเทมเพลต --------------------------------------------
  // Every member of staff browses the current versions; MACOM manages.

  @ApiOperation({
    summary: 'CD-273 คลังแบรนด์ — ไฟล์ฉบับปัจจุบัน (หมวด ค้นหา)',
  })
  @Get('brand')
  @Authenticated()
  brandList(
    @Query() query: ListBrandAssetsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brand.list(principal, query);
  }

  @ApiOperation({
    summary: 'CD-273 ไฟล์แบรนด์หนึ่งรายการ (MACOM เห็นประวัติฉบับ)',
  })
  @Get('brand/:id')
  @Authenticated()
  brandOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.brand.one(principal, id);
  }

  @ApiOperation({ summary: 'CD-273 ดาวน์โหลดฉบับปัจจุบัน' })
  @Get('brand/:id/file')
  @Authenticated()
  async brandFile(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    return this.brandStream(await this.brandFiles.file(principal, id));
  }

  @ApiOperation({ summary: 'CD-273 ดาวน์โหลดฉบับใดก็ได้ (MACOM)' })
  @Get('brand/:id/versions/:versionId/file')
  @Permissions('crm.campaign.manage')
  async brandVersionFile(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    return this.brandStream(
      await this.brandFiles.file(principal, id, versionId),
    );
  }

  @ApiOperation({
    summary:
      'CD-273 เพิ่มไฟล์ใหม่ + ฉบับแรก (รออนุมัติ — ยื่นคำขอตามตั้งค่า CRM)',
  })
  @Post('brand')
  @Permissions('crm.campaign.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BRAND_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  createBrandAsset(
    @Body() dto: CreateBrandAssetDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brandFiles.create(principal, dto, file);
  }

  @ApiOperation({ summary: 'CD-273 อัปโหลดฉบับใหม่ (รออนุมัติ)' })
  @Post('brand/:id/versions')
  @Permissions('crm.campaign.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BRAND_FILE_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  addBrandVersion(
    @Param('id') id: string,
    @Body() dto: BrandVersionNoteDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brandFiles.addVersion(principal, id, dto.note, file);
  }

  @ApiOperation({ summary: 'CD-273 แก้ชื่อ หมวด คำอธิบาย แท็ก' })
  @Patch('brand/:id')
  @Permissions('crm.campaign.manage')
  updateBrandAsset(
    @Param('id') id: string,
    @Body() dto: UpdateBrandAssetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brand.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-273 เลิกใช้ไฟล์ (ซ่อนจากทุกคน เก็บประวัติไว้)' })
  @Post('brand/:id/retire')
  @Permissions('crm.campaign.manage')
  retireBrandAsset(
    @Param('id') id: string,
    @Body() dto: RetireBrandAssetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brand.retire(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-273 เปิดใช้ไฟล์ที่เลิกใช้กลับมา' })
  @Post('brand/:id/restore')
  @Permissions('crm.campaign.manage')
  restoreBrandAsset(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brand.retire(principal, id, null);
  }

  @ApiOperation({ summary: 'CD-273 ถอนฉบับที่รออนุมัติ (ยกเลิกคำขอ)' })
  @Post('brand-versions/:versionId/withdraw')
  @Permissions('crm.campaign.manage')
  withdrawBrandVersion(
    @Param('versionId') versionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.brand.withdraw(principal, versionId);
  }

  /** Pictures and PDFs open in the browser; everything else (SVG too) downloads. */
  private brandStream(file: {
    stream: import('node:stream').Readable;
    fileName: string;
    mimeType: string;
  }) {
    const name = encodeURIComponent(file.fileName);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `${inlineSafe(file.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
    });
  }

  // --- CD-272 อนุมัติสื่อและเนื้อหา -------------------------------------------

  @ApiOperation({
    summary: 'CD-272 ส่งอนุมัติคอนเทนต์ (ยื่นคำขอตามประเภทในตั้งค่า CRM)',
  })
  @Post('content/:id/approval')
  @Permissions('crm.campaign.manage')
  sendForApproval(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contentApproval.send(principal, id);
  }

  @ApiOperation({
    summary: 'CD-272 ถอนออกจากการรออนุมัติ (ยกเลิกคำขอ) กลับเป็นร่าง',
  })
  @Post('content/:id/approval/withdraw')
  @Permissions('crm.campaign.manage')
  withdrawApproval(
    @Param('id') id: string,
    @Body() dto: WithdrawContentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contentApproval.withdraw(principal, id, dto.reason ?? '');
  }

  // --- CD-271 ปฏิทินคอนเทนต์ ------------------------------------------------

  @ApiOperation({
    summary: 'CD-271 ปฏิทินคอนเทนต์ (ช่วงวันที่ ช่องทาง สถานะ แคมเปญ)',
  })
  @Get('content')
  @AnyPermission('crm.sales.read', 'crm.campaign.manage')
  contentList(
    @Query() query: ListContentQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.list(principal, query);
  }

  @ApiOperation({ summary: 'CD-271 คอนเทนต์หนึ่งชิ้นพร้อมไฟล์' })
  @Get('content/:id')
  @AnyPermission('crm.sales.read', 'crm.campaign.manage')
  contentOne(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.one(principal, id);
  }

  @ApiOperation({ summary: 'CD-271 สร้างคอนเทนต์ (ร่าง)' })
  @Post('content')
  @Permissions('crm.campaign.manage')
  createContent(
    @Body() dto: SaveContentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.create(principal, dto);
  }

  @ApiOperation({ summary: 'CD-271 แก้คอนเทนต์ (ก่อนเผยแพร่)' })
  @Put('content/:id')
  @Permissions('crm.campaign.manage')
  updateContent(
    @Param('id') id: string,
    @Body() dto: SaveContentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.update(principal, id, dto);
  }

  @ApiOperation({
    summary:
      'CD-271 เปลี่ยนสถานะ: พร้อม / เผยแพร่แล้ว (ลิงก์) / ยกเลิก (เหตุผล) / กลับเป็นร่าง',
  })
  @Post('content/:id/move')
  @Permissions('crm.campaign.manage')
  moveContent(
    @Param('id') id: string,
    @Body() dto: MoveContentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.move(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-271 คัดลอกไปอีกช่องทาง (ร่างใหม่ ไฟล์เดิม)' })
  @Post('content/:id/copy')
  @Permissions('crm.campaign.manage')
  copyContent(
    @Param('id') id: string,
    @Body() dto: CopyContentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.content.copy(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-271 แนบสื่อ (รูป/วิดีโอ MP4/PDF)' })
  @Post('content/:id/files')
  @Permissions('crm.campaign.manage')
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
      limits: { fileSize: MAX_CONTENT_MEDIA_BYTES },
      defParamCharset: 'utf8',
    }),
  )
  attachContentFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contentFiles.attach(principal, id, file);
  }

  @ApiOperation({ summary: 'CD-271 เอาไฟล์ออกจากคอนเทนต์' })
  @Delete('content/:id/files/:fileId')
  @Permissions('crm.campaign.manage')
  removeContentFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.contentFiles.remove(principal, id, fileId);
  }

  @ApiOperation({ summary: 'CD-271 ไฟล์สื่อของคอนเทนต์' })
  @Get('content/:id/files/:fileId')
  @AnyPermission('crm.sales.read', 'crm.campaign.manage')
  async contentFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.contentFiles.file(principal, id, fileId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  // --- CD-270 อีเวนต์ --------------------------------------------------------
  // Registrations carry phones and e-mails of people who are not customers
  // yet: campaign managers only.

  @ApiOperation({
    summary: 'CD-270 รายชื่อผู้ลงทะเบียนอีเวนต์ + ตัวเลขสรุป (เช็กอินหน้างาน)',
  })
  @Get('events/:campaignId/registrations')
  @Permissions('crm.campaign.manage')
  registrations(
    @Param('campaignId') campaignId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.list(principal, campaignId);
  }

  @ApiOperation({ summary: 'CD-270 เพิ่ม walk-in หน้างาน (นับว่ามาแล้ว)' })
  @Post('events/:campaignId/walk-ins')
  @Permissions('crm.campaign.manage')
  walkIn(
    @Param('campaignId') campaignId: string,
    @Body() dto: WalkInDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.walkIn(principal, campaignId, dto);
  }

  @ApiOperation({
    summary: 'CD-270 แปลงผู้เข้าร่วมที่สนใจเป็น Lead (ผ่านการคัดกรอง CD-269)',
  })
  @Post('events/:campaignId/convert')
  @Permissions('crm.campaign.manage')
  convert(
    @Param('campaignId') campaignId: string,
    @Body() dto: ConvertRegistrationsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.convert(principal, campaignId, dto);
  }

  @ApiOperation({ summary: 'CD-270 เช็กอิน / ยกเลิกเช็กอิน' })
  @Post('event-registrations/:id/check-in')
  @Permissions('crm.campaign.manage')
  checkIn(
    @Param('id') id: string,
    @Body() dto: CheckInDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.checkIn(principal, id, dto.attended);
  }

  @ApiOperation({ summary: 'CD-270 ให้ที่นั่งจากรายชื่อสำรอง หรือยกเลิก' })
  @Post('event-registrations/:id/status')
  @Permissions('crm.campaign.manage')
  setStatus(
    @Param('id') id: string,
    @Body() dto: RegistrationStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.setStatus(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-270 ความสนใจและหมายเหตุหลังงาน' })
  @Patch('event-registrations/:id/follow')
  @Permissions('crm.campaign.manage')
  follow(
    @Param('id') id: string,
    @Body() dto: FollowRegistrationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.events.follow(principal, id, dto);
  }

  // --- CD-268 แผนงบแคมเปญ ---------------------------------------------------

  @ApiOperation({
    summary: 'CD-268 แผนงบของแคมเปญ: งบรายช่องทางและค่าใช้จ่ายจริง',
  })
  @Get('campaigns/:id/plan')
  @AnyPermission('crm.sales.read', 'crm.campaign.manage')
  plan(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.plans.plan(principal, id);
  }

  @ApiOperation({
    summary: 'CD-268 บันทึกงบรายช่องทาง (ทั้งชุด) — งบรวมแคมเปญ = ผลรวม',
  })
  @Put('campaigns/:id/budget-lines')
  @Permissions('crm.campaign.manage')
  saveLines(
    @Param('id') id: string,
    @Body() dto: SaveBudgetLinesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plans.saveLines(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-268 บันทึกค่าใช้จ่ายจริงของแคมเปญ' })
  @Post('campaigns/:id/spends')
  @Permissions('crm.campaign.manage')
  addSpend(
    @Param('id') id: string,
    @Body() dto: AddCampaignSpendDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plans.addSpend(principal, id, dto);
  }

  @ApiOperation({ summary: 'CD-268 ยกเลิกค่าใช้จ่าย (ไม่ลบ — เก็บเหตุผล)' })
  @Post('campaign-spends/:spendId/void')
  @Permissions('crm.campaign.manage')
  voidSpend(
    @Param('spendId') spendId: string,
    @Body() dto: VoidCampaignSpendDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.plans.voidSpend(principal, spendId, dto);
  }

  @ApiOperation({ summary: 'CD-268 แนบ/เปลี่ยนใบเสร็จของค่าใช้จ่าย' })
  @Post('campaign-spends/:spendId/receipt')
  @Permissions('crm.campaign.manage')
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
  attachReceipt(
    @Param('spendId') spendId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.receipts.attach(principal, spendId, file);
  }

  @ApiOperation({ summary: 'CD-268 ไฟล์ใบเสร็จของค่าใช้จ่าย' })
  @Get('campaign-spends/:spendId/receipt')
  @AnyPermission('crm.sales.read', 'crm.campaign.manage')
  async receipt(
    @Param('spendId') spendId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.receipts.file(principal, spendId);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }
}
