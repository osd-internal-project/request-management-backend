import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { DisbursementsService } from './disbursements.service';
import {
  CloseDisbursementDto,
  ListDisbursementsQueryDto,
  PayDisbursementDto,
  ReturnClearingDto,
  SubmitClearingDto,
  VerifyDisbursementDto,
  VoidPaymentDto,
} from './disbursement.dto';

/**
 * การเบิก (docs/disbursement.md). Reads and clearing take the request's own
 * permissions — the service limits them to the requester's rows unless the
 * caller holds `disbursement.read.any`.
 */
@ApiTags('disbursement')
@ApiBearerAuth()
@Controller('disbursements')
export class DisbursementsController {
  constructor(private readonly disbursements: DisbursementsService) {}

  @ApiOperation({
    summary: 'สร้างใบเบิกจากคำขอที่อนุมัติแล้ว — ใช้เมื่อระบบสร้างให้อัตโนมัติไม่สำเร็จ; มีอยู่แล้วตอบใบเดิม',
  })
  @Post('from-request/:requestNo')
  @Permissions('disbursement.pay')
  fromRequest(
    @Param('requestNo') requestNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.fromRequest(principal, requestNo);
  }

  @ApiOperation({ summary: 'ยกเลิกงวดจ่าย — ต้องเป็นเจ้าหน้าที่คนอื่น ไม่ใช่ผู้จ่ายงวดนั้น' })
  @Post(':docNo/payments/:movementId/void')
  @Permissions('disbursement.pay')
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
  @Permissions('request.read')
  list(
    @Query() query: ListDisbursementsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.list(principal, query);
  }

  @ApiOperation({ summary: 'ใบเบิกของคำขอ' })
  @Get('by-request/:requestNo')
  @Permissions('request.read')
  byRequest(
    @Param('requestNo') requestNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.byRequestNo(principal, requestNo);
  }

  @ApiOperation({ summary: 'รายละเอียดใบเบิก รายการประมาณการ/ใช้จริง และ movement เงิน' })
  @Get(':docNo')
  @Permissions('request.read')
  detail(
    @Param('docNo') docNo: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.detail(principal, docNo);
  }

  @ApiOperation({
    summary: 'บัญชีตรวจสอบ — เฉพาะใบเบิกตาม flow เดิม (flow ใหม่ตรวจที่ขั้น VERIFY ของคำขอ)',
  })
  @Post(':docNo/verify')
  @Permissions('disbursement.verify')
  verify(
    @Param('docNo') docNo: string,
    @Body() dto: VerifyDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.disbursements.verify(principal, docNo, dto, authorization);
  }

  @ApiOperation({ summary: 'จ่ายเงิน — เงินทดรองรอเคลียร์ / เงินสดย่อยปิดทันที' })
  @Post(':docNo/pay')
  @Permissions('disbursement.pay')
  pay(
    @Param('docNo') docNo: string,
    @Body() dto: PayDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.disbursements.pay(principal, docNo, dto, authorization);
  }

  @ApiOperation({ summary: 'ผู้ขอส่งเคลียร์ค่าใช้จ่ายจริง' })
  @Post(':docNo/clearing')
  @Permissions('request.create')
  submitClearing(
    @Param('docNo') docNo: string,
    @Body() dto: SubmitClearingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.submitClearing(principal, docNo, dto);
  }

  @ApiOperation({ summary: 'บัญชีตีกลับเอกสารเคลียร์ให้ผู้ขอแก้' })
  @Post(':docNo/clearing/return')
  @Permissions('disbursement.verify')
  returnClearing(
    @Param('docNo') docNo: string,
    @Body() dto: ReturnClearingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.disbursements.returnClearing(principal, docNo, dto);
  }

  @ApiOperation({
    summary: 'ปิดเงินทดรอง — คิดส่วนต่าง (คืน/เบิกเพิ่ม) แล้วจบคำขอ',
  })
  @Post(':docNo/close')
  @Permissions('disbursement.pay')
  close(
    @Param('docNo') docNo: string,
    @Body() dto: CloseDisbursementDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.disbursements.close(principal, docNo, dto, authorization);
  }
}
