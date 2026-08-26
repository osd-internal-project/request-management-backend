import { Injectable } from '@nestjs/common';
import { AuditWriter, auditActor } from '@request-management/share';
import type {
  Principal,
  SensitiveReadRecorder,
} from '@request-management/share';

/**
 * SCOPE-05 for core-service.
 *
 * user-service records these through its own `PolicyService`; here the entry
 * goes straight to the shared append-only log. Same table, same event name —
 * "who saw whose data" has to read as one trail regardless of which service
 * served the request.
 */
@Injectable()
export class SensitiveReadAuditRecorder implements SensitiveReadRecorder {
  constructor(private readonly audit: AuditWriter) {}

  async recordSensitiveRead(
    actor: Principal,
    resource: string,
    resourceId: string,
    fields: readonly string[],
  ): Promise<void> {
    await this.audit.record({
      eventType: 'scope.sensitive_field.read',
      companyId: actor.activeCompanyId || null,
      ...auditActor(actor),
      resourceType: resource,
      resourceId,
      after: { fields: [...fields] },
    });
  }
}
