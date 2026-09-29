import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  type ApiKeyContext,
  CurrentApiKey,
  CustomerIntakeService,
  IntakeSubmissionDto,
  INTAKE_CHANNELS,
  type IntakeChannelCode,
} from '@request-management/core-service';
import { AppError } from '@request-management/share';

/**
 * CD-66 — คำขอจากลูกค้า: customers raising requests through a company's
 * intake channels. Called by a channel's server side — the public web form's
 * (the frontend holds the key; the page itself never does), AI CARE, or the
 * LINE connector — with a key holding **`integration.request.intake` only**.
 *
 * That scope cannot act as a person: it opens these routes and nothing else,
 * unlike `integration.request.create`, which also opens the `X-Acting-User`
 * routes. A key behind a public form must be the former.
 *
 * Robot-only like `request/intake`: nobody of ours is at the other end. The
 * request is raised for the channel's designated staff user, with the
 * customer as its contact (CustomerIntakeService).
 */
@ApiTags('request')
@ApiBearerAuth()
@Controller('request/intake')
export class CustomerIntakeController {
  constructor(private readonly intake: CustomerIntakeService) {}

  @Get('web-forms/:slug')
  @Permissions('integration.request.intake')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'แบบฟอร์มสาธารณะ: ข้อความและประเภทคำขอที่เปิดรับ (CD-66)',
    description:
      'key ที่ผูกบริษัทไว้เปิดได้เฉพาะฟอร์มของบริษัทนั้น · ฟอร์มที่ปิดอยู่ตอบ 404',
  })
  webForm(
    @Param('slug') slug: string,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.intake.webForm(slug, key?.companyId ?? null);
  }

  @Post('web-forms/:slug')
  @Permissions('integration.request.intake')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ลูกค้ายื่นคำขอผ่านแบบฟอร์มสาธารณะ (CD-66)',
    description:
      'ยื่นทันที — ตอบเลขคำขอกับ status_token (แสดงครั้งเดียว ใช้เปิดลิงก์ติดตามสถานะ)',
  })
  submitWebForm(
    @Param('slug') slug: string,
    @Body() dto: IntakeSubmissionDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
    @Headers('authorization') authorization: string,
  ) {
    return this.intake.submitWebForm(
      slug,
      dto,
      principal,
      key?.companyId ?? null,
      authorization,
    );
  }

  @Post('channels/:channel')
  @Permissions('integration.request.intake')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ช่องทางอื่น (เช่น AI CARE) ยื่นคำขอแทนลูกค้า (CD-66)',
    description:
      'บริษัท = บริษัทของ key (หรือ X-Company-Id สำหรับ key ที่ไม่ผูกบริษัท) · ช่องทางต้องเปิดอยู่',
  })
  submitChannel(
    @Param('channel') channel: string,
    @Body() dto: IntakeSubmissionDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    if (!(INTAKE_CHANNELS as readonly string[]).includes(channel)) {
      throw new AppError('NOT_FOUND', 'ไม่รู้จักช่องทางนี้');
    }
    return this.intake.submitChannel(
      channel as IntakeChannelCode,
      principal.activeCompanyId,
      dto,
      principal,
      authorization,
    );
  }

  @Get('status/:token')
  @Permissions('integration.request.intake')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'สถานะคำขอตามลิงก์ติดตามของลูกค้า (CD-66)',
    description:
      'เลข ประเภท สถานะ และกำหนดเสร็จ — ไม่มีบันทึกภายในหรือชื่อพนักงาน',
  })
  status(@Param('token') token: string) {
    return this.intake.status(token);
  }
}
