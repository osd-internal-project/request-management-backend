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
import { OpportunitiesService } from './opportunities.service';
import {
  ConvertLeadDto,
  CreateOpportunityDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ImportLeadsDto,
  ListOpportunitiesQueryDto,
  ListLeadsQueryDto,
  LoseOpportunityDto,
  UpdateOpportunityDto,
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

  /** แปลงเป็นโอกาสการขาย — ข้อมูลไหลต่อ. */
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

/** CRM โอกาสการขาย (Opportunity). */
@ApiTags('opportunities')
@ApiBearerAuth()
@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOpportunitiesQueryDto,
  ) {
    return this.opportunities.list(principal, query);
  }

  /** เหตุผลปิดแพ้มาตรฐาน — declared before `:id`. */
  @Get('lost-reasons')
  @Permissions('crm.sales.read')
  lostReasons(@CurrentPrincipal() principal: Principal) {
    return this.opportunities.lostReasonOptions(principal);
  }

  @Post()
  @Permissions('crm.sales.manage')
  create(
    @Body() dto: CreateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.create(dto, principal);
  }

  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.opportunities.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.update(id, dto, principal);
  }

  @Post(':id/win')
  @Permissions('crm.sales.manage')
  win(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.opportunities.win(id, principal);
  }

  /** ปิดแพ้ — เหตุผลมาตรฐานบังคับ (spec CRM). */
  @Post(':id/lose')
  @Permissions('crm.sales.manage')
  lose(
    @Param('id') id: string,
    @Body() dto: LoseOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.lose(id, dto, principal);
  }
}
