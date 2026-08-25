import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions } from '@request-management/share';
import { AuditService } from './audit.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

/**
 * SUP-04 — read-only by design.
 *
 * There is intentionally no POST, PATCH, or DELETE here. If one ever appears
 * in a diff, the append-only guarantee is gone and the DoD check that greps
 * the generated OpenAPI for mutating `/audit-logs` routes will fail.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Permissions('audit.read')
  search(@Query() query: QueryAuditLogDto) {
    return this.auditService.search(query);
  }
}
