import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ActingPermissions,
  ActingPolicyGuard,
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CloseDisbursementDto,
  DisbursementsService,
  ListDisbursementsQueryDto,
  PayDisbursementDto,
  ReturnClearingDto,
  SubmitClearingDto,
  VerifyDisbursementDto,
  VoidPaymentDto,
} from '@request-management/core-service';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
} from '../auth/acting-user.guard';
import { BearerToken } from '../auth/bearer-token.decorator';

/**
 * การเบิก on the external port — the same routes as the screens
 * (`disbursement-route-parity.spec.ts`), behind both gates (AGENTS.md).
 * Evidence files stay screen-only: this service has no object storage.
 */
@ApiTags('disbursement')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('disbursement/disbursements')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalDisbursementsController {
  constructor(private readonly disbursements: DisbursementsService) {}

  @ApiOperation({
    summary: 'สร้างใบเบิกจากคำขอที่อนุมัติแล้ว — ใช้เมื่อระบบสร้างให้อัตโนมัติไม่สำเร็จ; มีอยู่แล้วตอบใบเดิม',
  })
  @Post('from-request/:requestNo')
  @Permissions('integration.disbursement.pay')
  @ActingPermissions('disbursement.pay')
  fromRequest(
    @Param('requestNo') requestNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.fromRequest(principal, requestNo);
  }

  @ApiOperation({ summary: 'ยกเลิกงวดจ่าย — ต้องเป็นเจ้าหน้าที่คนอื่น ไม่ใช่ผู้จ่ายงวดนั้น' })
  @Post(':docNo/payments/:movementId/void')
  @Permissions('integration.disbursement.pay')
  @ActingPermissions('disbursement.pay')
  voidPayment(
    @Param('docNo') docNo: string,
    @Param('movementId') movementId: string,
    @Body() dto: VoidPaymentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.voidPayment(principal, docNo, movementId, dto);
  }

  @ApiOperation({ summary: 'รายการใบเบิกที่ผู้ใช้เห็นได้ — กรองหลายสถานะ, ของฉัน, เลยกำหนดเคลียร์' })
  @Get()
  @Permissions('integration.request.read')
  @ActingPermissions('request.read')
  list(
    @Query() query: ListDisbursementsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.list(principal, query);
  }

  @ApiOperation({ summary: 'ใบเบิกของคำขอ' })
  @Get('by-request/:requestNo')
  @Permissions('integration.request.read')
  @ActingPermissions('request.read')
  byRequest(
    @Param('requestNo') requestNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.byRequestNo(principal, requestNo);
  }

  @ApiOperation({ summary: 'รายละเอียดใบเบิก รายการประมาณการ/ใช้จริง และ movement เงิน' })
  @Get(':docNo')
  @Permissions('integration.request.read')
  @ActingPermissions('request.read')
  detail(
    @Param('docNo') docNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.detail(principal, docNo);
  }

  @ApiOperation({
    summary: 'บัญชีตรวจสอบ — เปิดเคสอนุมัติผู้บริหาร (ถ้ามี matrix) หรืออนุมัติทันที',
  })
  @Post(':docNo/verify')
  @Permissions('integration.disbursement.verify')
  @ActingPermissions('disbursement.verify')
  verify(
    @Param('docNo') docNo: string,
    @Body() dto: VerifyDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.disbursements.verify(principal, docNo, dto, authorization);
  }

  @ApiOperation({ summary: 'จ่ายเงิน — เงินทดรองรอเคลียร์ / เงินสดย่อยปิดทันที' })
  @Post(':docNo/pay')
  @Permissions('integration.disbursement.pay')
  @ActingPermissions('disbursement.pay')
  pay(
    @Param('docNo') docNo: string,
    @Body() dto: PayDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.disbursements.pay(principal, docNo, dto, authorization);
  }

  @ApiOperation({ summary: 'ผู้ขอส่งเคลียร์ค่าใช้จ่ายจริง' })
  @Post(':docNo/clearing')
  @Permissions('integration.request.create')
  @ActingPermissions('request.create')
  submitClearing(
    @Param('docNo') docNo: string,
    @Body() dto: SubmitClearingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.submitClearing(principal, docNo, dto);
  }

  @ApiOperation({ summary: 'บัญชีตีกลับเอกสารเคลียร์ให้ผู้ขอแก้' })
  @Post(':docNo/clearing/return')
  @Permissions('integration.disbursement.verify')
  @ActingPermissions('disbursement.verify')
  returnClearing(
    @Param('docNo') docNo: string,
    @Body() dto: ReturnClearingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.returnClearing(principal, docNo, dto);
  }

  @ApiOperation({
    summary: 'บัญชีเคลียร์เอกสาร (complete) — คิดส่วนต่าง (คืน/เบิกเพิ่ม) แล้วจบคำขอ',
    description:
      'มีส่วนต่างต้องส่ง `method` และต้องมีสลิปที่แนบหลังส่งเคลียร์ครั้งล่าสุด: คืนเงิน = `REFUND_PROOF`, ' +
      'จ่ายเพิ่ม = `PAYMENT_SLIP` — ไม่มีได้ `400 VALIDATION_FAILED` field `files` (แนบไฟล์ได้ที่หน้าเว็บเท่านั้น)',
  })
  @Post(':docNo/close')
  @Permissions('integration.disbursement.pay')
  @ActingPermissions('disbursement.pay')
  close(
    @Param('docNo') docNo: string,
    @Body() dto: CloseDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @BearerToken() authorization: string,
  ) {
    return this.disbursements.close(principal, docNo, dto, authorization);
  }
}
