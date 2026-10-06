import {
  Body,
  Controller,
  Get,
  Param,
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
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { CampaignPlanService } from './campaign-plan.service';
import { CampaignReceiptsService } from './campaign-receipts.service';
import { CampaignEventsService } from '../crm/campaign-events.service';
import {
  CheckInDto,
  ConvertRegistrationsDto,
  FollowRegistrationDto,
  RegistrationStatusDto,
  WalkInDto,
} from '../crm/dto/sales.dto';
import {
  AddCampaignSpendDto,
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
  ) {}

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
