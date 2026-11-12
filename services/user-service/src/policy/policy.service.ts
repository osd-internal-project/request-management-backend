import { Injectable } from '@nestjs/common';
import {
  Permission,
  Principal,
  PrismaTransactionService,
  TxOption,
} from '@request-management/share';
import type { SensitiveFieldRule } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { SensitiveFieldRuleRepository } from './sensitive-field-rule.repository';
import { ReplaceSensitiveFieldRulesDto } from './dto/policy.dto';

@Injectable()
export class PolicyService {
  constructor(
    private readonly sensitiveFields: SensitiveFieldRuleRepository,
    private readonly audit: AuditService,
    private readonly transactions: PrismaTransactionService,
  ) {}

  listSensitiveFieldRules(): Promise<SensitiveFieldRule[]> {
    return this.sensitiveFields.findAll();
  }

  /**
   * SCOPE-04: which sensitive fields this permission set unmasks. Anything not
   * listed stays masked in the API response, not merely hidden in the UI.
   */
  /** Every declared sensitive field as `resource.field` — what to mask against. */
  async listAllSensitiveFieldKeys(option?: TxOption): Promise<string[]> {
    const rules = await this.sensitiveFields.findAll(option);
    return rules.map((rule) => `${rule.resource}.${rule.field}`);
  }

  async resolveVisibleSensitiveFields(
    permissions: readonly Permission[],
    option?: TxOption,
  ): Promise<string[]> {
    const rules = await this.sensitiveFields.findAll(option);

    return rules
      .filter((rule) =>
        permissions.includes(rule.visibleToPermission as Permission),
      )
      .map((rule) => `${rule.resource}.${rule.field}`);
  }

  async replaceSensitiveFieldRules(
    dto: ReplaceSensitiveFieldRulesDto,
    actor: Principal,
  ): Promise<SensitiveFieldRule[]> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      // The DTO groups fields per resource for the admin UI; the table stores
      // one row per field so a single field can be regranted on its own.
      const entries = dto.rules.flatMap((rule) =>
        rule.fields.map((field) => ({
          resource: rule.resource,
          field,
          visibleToPermission: rule.visible_to_permission,
        })),
      );

      const after = await this.sensitiveFields.upsertMany(
        entries,
        actor.userId,
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.SENSITIVE_FIELD_RULE_UPDATED,
          companyId: actor.activeCompanyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'sensitive_field_rule',
          after: entries,
        },
        option,
      );

      return after;
    });
  }

  /** SCOPE-05: record that someone opened a record carrying sensitive fields. */
  async recordSensitiveRead(
    actor: Principal,
    resource: string,
    resourceId: string,
    fields: readonly string[],
  ): Promise<void> {
    if (!fields.length) return;

    await this.audit.record({
      eventType: AuditEvent.SENSITIVE_FIELD_READ,
      companyId: actor.activeCompanyId,
      actorId: actor.userId,
      actorUsername: actor.username,
      resourceType: resource,
      resourceId,
      after: { fields: [...fields] },
    });
  }
}
