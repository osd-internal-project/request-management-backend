import {
  Body,
  Controller,
  Get,
  Param,
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
  ) {}

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
