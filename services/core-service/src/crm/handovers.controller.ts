import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  OBJECT_STORAGE,
  Permissions,
} from '@request-management/share';
import type { ObjectStorage, Principal } from '@request-management/share';
import { HandoversService } from './handovers.service';
import {
  HandoverListQueryDto,
  ReturnHandoverDto,
  SaveHandoverDto,
} from './dto/sales.dto';

/**
 * CD-84 — ส่งมอบงานต่อ, for the screens only.
 *
 * Not in `generate-crm-controllers.py`: the handover is between two teams of
 * people, and the receiving side is gated on team membership, not on a CRM
 * permission — the delivery team does not hold `crm.sales.read`, and needs
 * none to accept work sent to it. `@Authenticated()` on those routes is that
 * decision; `HandoversService` checks the team.
 */
@ApiTags('handovers')
@ApiBearerAuth()
@Controller()
export class HandoversController {
  constructor(
    private readonly handovers: HandoversService,
    // CD-144 — the package's design files; storage lives in the HTTP half.
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @ApiOperation({
    summary: 'งานส่งมอบของโอกาสการขาย + รายการตรวจที่ต้องกรอก',
    description:
      '`editable` = ดีลชนะแล้วและยังไม่ได้ส่ง (หรือถูกตีกลับ) · `items` = รายการตรวจปัจจุบันรวมคำตอบที่บันทึกไว้',
  })
  @Get('opportunities/:id/handover')
  @Permissions('crm.sales.read')
  forDeal(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.handovers.forDeal(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกร่างงานส่งมอบ' })
  @Put('opportunities/:id/handover')
  @Permissions('crm.sales.manage')
  save(
    @Param('id') id: string,
    @Body() dto: SaveHandoverDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.save(id, dto, principal);
  }

  @ApiOperation({
    summary: 'ส่งมอบงานให้ทีมถัดไป (รายการตรวจไม่ครบ = ส่งไม่ได้)',
  })
  @Post('opportunities/:id/handover/submit')
  @Permissions('crm.sales.manage')
  submit(
    @Param('id') id: string,
    @Body() dto: SaveHandoverDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.submit(id, dto, principal);
  }

  @ApiOperation({
    summary: 'กล่องงานส่งมอบ',
    description:
      'box=incoming (ค่าเริ่มต้น) ส่งถึงทีมที่ฉันอยู่หรือเป็นหัวหน้า · box=sent ที่ฉันส่ง/ดีลของฉัน',
  })
  @Get('handovers')
  @Authenticated()
  list(
    @Query() query: HandoverListQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.list(principal, query);
  }

  @Get('handovers/:id')
  @Authenticated()
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.handovers.findOne(id, principal);
  }

  @ApiOperation({
    summary: 'ไฟล์แบบในชุดเอกสารเทคนิคของงานส่งมอบ (CD-144)',
  })
  @Get('handovers/:id/solution-files/:fileId')
  @Authenticated()
  async technicalFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.handovers.technicalFile(id, fileId, principal);
    return new StreamableFile(await this.storage.get(file.storageKey), {
      type: file.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'รับงานส่งมอบ (คนในทีมที่ได้รับ)' })
  @Post('handovers/:id/accept')
  @Authenticated()
  accept(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.handovers.accept(id, principal);
  }

  @ApiOperation({ summary: 'ตีกลับงานส่งมอบให้ฝ่ายขายแก้ (ต้องมีเหตุผล)' })
  @Post('handovers/:id/return')
  @Authenticated()
  returnToSales(
    @Param('id') id: string,
    @Body() dto: ReturnHandoverDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.returnToSales(id, dto.reason, principal);
  }
}
