import {
  Body,
  Controller,
  Get,
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
import {
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
  ) {}

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
