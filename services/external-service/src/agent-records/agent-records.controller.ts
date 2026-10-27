import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AgentRecordsService,
  CompleteAgentRecordDto,
  CurrentApiKey,
  type ApiKeyContext,
} from '@request-management/core-service';

/**
 * `api/v1/agent-records/:id` — Vuvagent closes a job CTD handed it (27 ต.ค. 2569).
 *
 * No acting user: the caller is the agent working for the company. The leads
 * it finds arrive through `crm/leads/intake` carrying `intake_data.agent_record_id`;
 * this route only finishes the record. Another company's id answers 404, and a
 * finished record answers 409 rather than being rewritten.
 */
@ApiTags('agent-records')
@ApiBearerAuth()
@Controller('agent-records')
@ActsAsCompany()
export class ExternalAgentRecordsController {
  constructor(private readonly records: AgentRecordsService) {}

  @Patch(':id')
  @Permissions('integration.agent.record.update')
  @ApiOperation({
    summary: 'ปิดงานที่ CTD ส่งให้ agent — done หรือ failed',
    description:
      'ไม่ต้องส่ง `X-Acting-User` · ปิดได้ครั้งเดียว ยิงซ้ำได้ 409 · ' +
      'lead ที่หาได้ส่งทาง `POST crm/leads/intake` พร้อม `intake_data.agent_record_id`',
  })
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteAgentRecordDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.records.complete(
      id,
      dto,
      principal,
      key?.companyId ?? principal.activeCompanyId,
    );
  }
}
