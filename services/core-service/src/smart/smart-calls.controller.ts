import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AddCallTargetsDto,
  CallListStatusDto,
  CertifyCallPolicyDto,
  RefuseCallDto,
  SaveCallListDto,
  SaveCallPolicyDto,
} from './smart-calls.dto';
import { SmartCallsService } from './smart-calls.service';

/** CD-291 (CD-16 AI SMART) — the calling policy, call lists and their targets. */
@ApiTags('smart')
@ApiBearerAuth()
@Controller('smart')
export class SmartCallsController {
  constructor(private readonly calls: SmartCallsService) {}

  @ApiOperation({ summary: 'CD-291 นโยบายการโทรของบริษัท และสถานะการรับรอง' })
  @Get('call-policy')
  @Permissions('smart.prospect.read')
  policy(@CurrentPrincipal() principal: Principal) {
    return this.calls.policy(principal);
  }

  @ApiOperation({
    summary: 'CD-291 บันทึกนโยบายการโทร — แก้แล้วการรับรองเดิมถูกยกเลิก',
  })
  @Put('call-policy')
  @Permissions('smart.call.manage')
  savePolicy(
    @Body() dto: SaveCallPolicyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.savePolicy(principal, dto);
  }

  @ApiOperation({ summary: 'CD-291 ฝ่ายกฎหมายรับรองนโยบายการโทรที่ใช้อยู่' })
  @Post('call-policy/certify')
  @Permissions('legal.contract.manage')
  certify(
    @Body() dto: CertifyCallPolicyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.certify(principal, dto.note);
  }

  @ApiOperation({ summary: 'CD-291 รายการโทรทั้งหมด พร้อมจำนวนตามสถานะ' })
  @Get('call-lists')
  @Permissions('smart.prospect.read')
  lists(@CurrentPrincipal() principal: Principal) {
    return this.calls.listLists(principal);
  }

  @ApiOperation({
    summary: 'CD-291 สร้างรายการโทร (บทพูด + บทความ KBMS ที่อ้าง)',
  })
  @Post('call-lists')
  @Permissions('smart.call.manage')
  create(
    @Body() dto: SaveCallListDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.createList(principal, dto);
  }

  @ApiOperation({ summary: 'CD-291 แก้รายการโทร' })
  @Put('call-lists/:id')
  @Permissions('smart.call.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveCallListDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.updateList(principal, id, dto);
  }

  @ApiOperation({
    summary: 'CD-291 เปิด/พัก/ปิดรายการโทร — เปิดได้เมื่อนโยบายได้รับรองแล้ว',
  })
  @Post('call-lists/:id/status')
  @Permissions('smart.call.manage')
  status(
    @Param('id') id: string,
    @Body() dto: CallListStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.setStatus(principal, id, dto.status);
  }

  @ApiOperation({ summary: 'CD-291 เพิ่มรายชื่อที่คัดกรองแล้วเข้ารายการโทร' })
  @Post('call-lists/:id/targets')
  @Permissions('smart.call.manage')
  addTargets(
    @Param('id') id: string,
    @Body() dto: AddCallTargetsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.addTargets(principal, id, dto.prospect_ids);
  }

  @ApiOperation({
    summary: 'CD-291 รายชื่อในรายการโทร พร้อมเหตุที่ยังโทรไม่ได้',
  })
  @Get('call-lists/:id/targets')
  @Permissions('smart.prospect.read')
  targets(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.calls.listTargets(principal, id);
  }

  @ApiOperation({
    summary: 'CD-291 บทที่ AI จะพูด: บทเปิด บทพูด บทความที่อ้าง',
  })
  @Get('call-lists/:id/script')
  @Permissions('smart.prospect.read')
  script(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.calls.script(principal, id);
  }

  @ApiOperation({
    summary: 'CD-291 ลูกค้าขอไม่ให้โทร — เข้าทะเบียนห้ามติดต่อทันที',
  })
  @Post('call-targets/:id/refuse')
  @Permissions('smart.call.manage')
  refuse(
    @Param('id') id: string,
    @Body() dto: RefuseCallDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.calls.refuse(
      principal.activeCompanyId,
      id,
      principal,
      dto.reason,
    );
  }
}
