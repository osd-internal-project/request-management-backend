import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SaveAiAuditPolicyDto } from './ai-audit.dto';
import { AiAuditService } from './ai-audit.service';

/**
 * CD-279 — how long the AI log is kept: a company setting, not an edit of
 * the log. Kept apart from the read-only log controller so SUP-04 (no
 * mutating route on an audit controller) holds; the paths are unchanged.
 */
@ApiTags('ai-audit')
@ApiBearerAuth()
@Controller('ai-audit')
export class AiRetentionController {
  constructor(private readonly audit: AiAuditService) {}

  @ApiOperation({ summary: 'CD-279 อายุการเก็บบันทึก AI ของบริษัท' })
  @Get('policy')
  @Permissions('admin.ai.audit')
  policy(@CurrentPrincipal() principal: Principal) {
    return this.audit.policy(principal);
  }

  @ApiOperation({ summary: 'CD-279 ตั้งอายุการเก็บบันทึก AI (วัน)' })
  @Put('policy')
  @Permissions('admin.ai.audit')
  savePolicy(
    @Body() dto: SaveAiAuditPolicyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audit.savePolicy(principal, dto);
  }
}
