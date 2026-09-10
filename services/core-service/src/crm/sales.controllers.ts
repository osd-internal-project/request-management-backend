import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { LeadsService } from './leads.service';
import { LeadImportService } from './lead-import.service';
import { DealsService } from './deals.service';
import {
  ConvertLeadDto,
  CreateDealDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ImportLeadsDto,
  ListDealsQueryDto,
  ListLeadsQueryDto,
  LoseDealDto,
  UpdateDealDto,
  UpdateLeadDto,
} from './dto/sales.dto';

/** CRM Lead — deny-by-default like every controller here. */
@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly importer: LeadImportService,
  ) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListLeadsQueryDto,
  ) {
    return this.leads.list(principal, query);
  }

  /** Import จาก Excel (parse ฝั่ง client) — dry_run ตอบรายงานเต็มไม่เขียน. */
  @Post('import')
  @Permissions('crm.sales.manage')
  import(
    @Body() dto: ImportLeadsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  @Post()
  @Permissions('crm.sales.manage')
  create(
    @Body() dto: CreateLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.create(dto, principal);
  }

  @Patch(':id')
  @Permissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.update(id, dto, principal);
  }

  /** คัดออกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/disqualify')
  @Permissions('crm.sales.manage')
  disqualify(
    @Param('id') id: string,
    @Body() dto: DisqualifyLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.disqualify(id, dto, principal);
  }

  /** แปลงเป็นดีล — ข้อมูลไหลต่อ. */
  @Post(':id/convert')
  @Permissions('crm.sales.manage')
  convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.convert(id, dto, principal);
  }
}

/** CRM โอกาสการขาย (ดีล). */
@ApiTags('deals')
@ApiBearerAuth()
@Controller('deals')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListDealsQueryDto,
  ) {
    return this.deals.list(principal, query);
  }

  /** เหตุผลปิดแพ้มาตรฐาน — declared before `:id`. */
  @Get('lost-reasons')
  @Permissions('crm.sales.read')
  lostReasons(@CurrentPrincipal() principal: Principal) {
    return this.deals.lostReasonOptions(principal);
  }

  @Post()
  @Permissions('crm.sales.manage')
  create(
    @Body() dto: CreateDealDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deals.create(dto, principal);
  }

  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.deals.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDealDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deals.update(id, dto, principal);
  }

  @Post(':id/win')
  @Permissions('crm.sales.manage')
  win(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.deals.win(id, principal);
  }

  /** ปิดแพ้ — เหตุผลมาตรฐานบังคับ (spec CRM). */
  @Post(':id/lose')
  @Permissions('crm.sales.manage')
  lose(
    @Param('id') id: string,
    @Body() dto: LoseDealDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.deals.lose(id, dto, principal);
  }
}
