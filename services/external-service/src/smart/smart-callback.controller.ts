import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CallResultDto,
  SmartDialerService,
} from '@request-management/core-service';

/**
 * CD-292 — D-Callcenter reports how an AI SMART call ended.
 *
 * Robot-only with no acting person — the seventh such route (AGENTS.md, "On
 * external-service"). The key's company is the call's company; a call id
 * from another company answers 404. Sending the same result twice is safe:
 * a finished call answers with what it already holds.
 */
@ApiTags('smart')
@ApiBearerAuth()
@Controller('smart/calls')
@ActsAsCompany()
export class ExternalSmartCallbackController {
  constructor(private readonly dialer: SmartDialerService) {}

  @ApiOperation({
    summary: 'D-Callcenter ส่งผลการโทรของ AI SMART',
    description:
      'call_id = รหัสที่ D-Callcenter ให้ตอนสั่งโทร · outcome: interested | not_interested | ' +
      'no_answer | busy | refused | failed · refused = ลูกค้าขอไม่ให้ติดต่อ — เบอร์เข้าทะเบียนห้ามติดต่อทันที',
  })
  @Post('callback')
  @Permissions('integration.smart.call.update')
  callback(
    @Body() dto: CallResultDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.dialer.recordResult(principal.activeCompanyId, {
      callId: dto.call_id,
      outcome: dto.outcome,
      durationSec: dto.duration_sec,
      transcript: dto.transcript,
      recordingRef: dto.recording_ref,
    });
  }
}
