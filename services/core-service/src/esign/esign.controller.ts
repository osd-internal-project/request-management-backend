import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
  Public,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { EsignLayoutsService } from './esign-layouts.service';
import { EsignService, type RequestMeta } from './esign.service';
import {
  CancelEnvelopeDto,
  DeclineDto,
  OtpRequestDto,
  OtpVerifyDto,
  SaveEsignLayoutDto,
  SignDto,
  VerifyHashDto,
} from './esign.dto';

/** Who is on the other end: the first forwarded address, and their browser. */
export function metaOf(request: Request): RequestMeta {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  return {
    ip: first || request.ip || null,
    userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
  };
}

const pdf = (file: { fileName: string; stream: NodeJS.ReadableStream }) =>
  new StreamableFile(file.stream as never, {
    type: 'application/pdf',
    disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  });

/** CD-14 — the screens: layouts, envelopes, and signing as an employee. */
@ApiTags('esign')
@ApiBearerAuth()
@Controller('esign')
export class EsignController {
  constructor(
    private readonly layouts: EsignLayoutsService,
    private readonly esign: EsignService,
  ) {}

  @ApiOperation({ summary: 'แม่แบบช่องลงนาม (CD-165)' })
  @Get('layouts')
  @Permissions('esign.manage')
  listLayouts(
    @Query('include_inactive') includeInactive: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.layouts.list(principal, includeInactive === 'true');
  }

  @ApiOperation({ summary: 'สร้างแม่แบบช่องลงนาม' })
  @Post('layouts')
  @Permissions('esign.manage')
  createLayout(
    @Body() dto: SaveEsignLayoutDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.layouts.create(dto, principal);
  }

  @ApiOperation({
    summary: 'แก้แม่แบบช่องลงนาม — ไม่กระทบเอกสารที่สร้างไปแล้ว',
  })
  @Patch('layouts/:id')
  @Permissions('esign.manage')
  updateLayout(
    @Param('id') id: string,
    @Body() dto: SaveEsignLayoutDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.layouts.update(id, dto, principal);
  }

  @ApiOperation({ summary: 'เอกสารรอลงนามของฉัน' })
  @Get('mine')
  @Authenticated()
  mine(@CurrentPrincipal() principal: Principal) {
    return this.esign.mine(principal);
  }

  @ApiOperation({ summary: 'เอกสารที่ส่งลงนาม — ผู้ลงนาม ความคืบหน้า ประวัติ' })
  @Get('envelopes/:id')
  @Permissions('esign.manage')
  view(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.esign.view(id, principal);
  }

  @ApiOperation({
    summary: 'ส่งลงนาม (CD-166)',
    description:
      'ผู้ลงนามภายนอกได้ลิงก์ใช้ครั้งเดียว — ลิงก์แสดงในคำตอบครั้งเดียว (ยังไม่มีอีเมล) · ผู้ลงนามภายในได้แจ้งเตือนในระบบเมื่อถึงลำดับ',
  })
  @Post('envelopes/:id/send')
  @Permissions('esign.manage')
  send(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ) {
    return this.esign.send(id, principal, metaOf(request));
  }

  @ApiOperation({ summary: 'ยกเลิกการส่งลงนาม' })
  @Post('envelopes/:id/cancel')
  @Permissions('esign.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelEnvelopeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.esign.cancel(id, dto.reason, principal);
  }

  @ApiOperation({ summary: 'เอกสารฉบับลงนาม (ผนึกแล้ว)' })
  @Get('envelopes/:id/signed')
  @Permissions('esign.manage')
  async signed(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return pdf(await this.esign.signedFile(id, principal));
  }

  @ApiOperation({ summary: 'เอกสารที่ฉันต้องลงนาม' })
  @Get('signers/:id')
  @Authenticated()
  signer(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.esign.internalView(id, principal);
  }

  @ApiOperation({ summary: 'เปิดอ่านเอกสารฉบับเต็ม (บันทึกว่าเปิดอ่านแล้ว)' })
  @Get('signers/:id/document')
  @Authenticated()
  async document(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ) {
    return pdf(
      await this.esign.internalDocument(id, principal, metaOf(request)),
    );
  }

  @ApiOperation({ summary: 'ลงนาม (ยืนยันตัวตนด้วยการล็อกอิน)' })
  @Post('signers/:id/sign')
  @Authenticated()
  sign(
    @Param('id') id: string,
    @Body() dto: SignDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ) {
    return this.esign.internalSign(id, dto, principal, metaOf(request));
  }

  @ApiOperation({ summary: 'ปฏิเสธการลงนาม' })
  @Post('signers/:id/decline')
  @Authenticated()
  decline(
    @Param('id') id: string,
    @Body() dto: DeclineDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ) {
    return this.esign.internalDecline(
      id,
      dto.reason,
      principal,
      metaOf(request),
    );
  }
}

/**
 * CD-166..173 — what a customer reaches without an account: the signing
 * link and the verification page. `@Public()`: the link's secret (only its
 * hash is stored) and the one-time code are the credentials; the
 * verification page shows only what the signed paper already says. The web
 * app calls these from its own server routes, which rate-limit by address.
 * Declared in AGENTS.md as the one public business surface of core-service.
 */
@ApiTags('esign')
@Controller('esign')
export class EsignPublicController {
  constructor(private readonly esign: EsignService) {}

  @ApiOperation({ summary: 'หน้าลงนามจากลิงก์ (สาธารณะ)' })
  @Get('public/:token')
  @Public()
  view(@Param('token') token: string, @Req() request: Request) {
    return this.esign.publicView(token, metaOf(request));
  }

  @ApiOperation({ summary: 'ส่งรหัสยืนยันตัวตนครั้งเดียว (CD-167)' })
  @Post('public/:token/code')
  @Public()
  sendCode(
    @Param('token') token: string,
    @Body() dto: OtpRequestDto,
    @Req() request: Request,
  ) {
    return this.esign.sendCode(token, dto.channel, metaOf(request));
  }

  @ApiOperation({ summary: 'ยืนยันรหัส' })
  @Post('public/:token/verify')
  @Public()
  verify(
    @Param('token') token: string,
    @Body() dto: OtpVerifyDto,
    @Req() request: Request,
  ) {
    return this.esign.verifyCode(token, dto.code, metaOf(request));
  }

  @ApiOperation({ summary: 'เอกสารฉบับเต็ม (หลังยืนยันรหัส)' })
  @Get('public/:token/document')
  @Public()
  async document(@Param('token') token: string, @Req() request: Request) {
    return pdf(await this.esign.publicDocument(token, metaOf(request)));
  }

  @ApiOperation({ summary: 'ลงนาม (CD-168)' })
  @Post('public/:token/sign')
  @Public()
  sign(
    @Param('token') token: string,
    @Body() dto: SignDto,
    @Req() request: Request,
  ) {
    return this.esign.publicSign(token, dto, metaOf(request));
  }

  @ApiOperation({ summary: 'ปฏิเสธการลงนาม' })
  @Post('public/:token/decline')
  @Public()
  decline(
    @Param('token') token: string,
    @Body() dto: DeclineDto,
    @Req() request: Request,
  ) {
    return this.esign.publicDecline(token, dto.reason, metaOf(request));
  }

  @ApiOperation({ summary: 'หน้าตรวจสอบเอกสาร (CD-173)' })
  @Get('verify/:code')
  @Public()
  verifyInfo(@Param('code') code: string) {
    return this.esign.verifyInfo(code);
  }

  @ApiOperation({
    summary: 'ไฟล์ที่ถืออยู่ตรงกับฉบับที่ลงนามหรือไม่ — ส่งเฉพาะ SHA-256',
  })
  @Post('verify/:code/check')
  @Public()
  check(@Param('code') code: string, @Body() dto: VerifyHashDto) {
    return this.esign.verifyHash(code, dto.sha256);
  }
}
