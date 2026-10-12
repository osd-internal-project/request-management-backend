import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { AiAuditSearchDto } from './ai-audit.dto';
import { AiAuditService } from './ai-audit.service';

/**
 * CD-279 — the AI audit log, read-only (SUP-04: no route here writes it).
 * Its retention setting is {@link AiRetentionController}.
 */
@ApiTags('ai-audit')
@ApiBearerAuth()
@Controller('ai-audit')
export class AiAuditController {
  constructor(private readonly audit: AiAuditService) {}

  @ApiOperation({
    summary:
      'CD-279 การเรียก MCP tool — ใคร เมื่อไร tool ไหน ตัวกรอง และรายการที่ตอบกลับ (id)',
  })
  @Get('mcp-calls')
  @Permissions('admin.ai.audit')
  mcp(
    @Query() query: AiAuditSearchDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audit.mcp(principal, query);
  }

  @ApiOperation({
    summary:
      'CD-279 การเรียกโมเดลผ่าน LLM Gateway — งาน โมเดล token ค่าใช้จ่าย',
  })
  @Get('llm-calls')
  @Permissions('admin.ai.audit')
  llm(
    @Query() query: AiAuditSearchDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.audit.llm(principal, query);
  }

  @ApiOperation({
    summary: 'CD-279 ตัวเลือกค้นหา: tool งาน AI และคนที่มีบันทึก',
  })
  @Get('filters')
  @Permissions('admin.ai.audit')
  filters(@CurrentPrincipal() principal: Principal) {
    return this.audit.filters(principal);
  }
}
