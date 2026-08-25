import { Injectable } from '@nestjs/common';
import {
  Permission,
  Principal,
  PrismaTransactionService,
  ScopeLevel,
  TxOption,
} from '@request-management/share';
import type { ScopeRule, SensitiveFieldRule } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { ScopeRuleRepository } from './scope-rule.repository';
import { SensitiveFieldRuleRepository } from './sensitive-field-rule.repository';
import {
  ReplaceScopeRulesDto,
  ReplaceSensitiveFieldRulesDto,
} from './dto/policy.dto';

/** Narrowest first — used to pick the widest scope a user's roles grant. */
const SCOPE_RANK: Readonly<Record<ScopeLevel, number>> = {
  own: 0,
  team: 1,
  department: 2,
  company: 3,
  all: 4,
};

@Injectable()
export class PolicyService {
  constructor(
    private readonly scopeRules: ScopeRuleRepository,
    private readonly sensitiveFields: SensitiveFieldRuleRepository,
    private readonly audit: AuditService,
    private readonly transactions: PrismaTransactionService,
  ) {}

  listScopeRules(): Promise<ScopeRule[]> {
    return this.scopeRules.findAll();
  }

  listSensitiveFieldRules(): Promise<SensitiveFieldRule[]> {
    return this.sensitiveFields.findAll();
  }

  /**
   * Resolves a user's effective scope per resource.
   *
   * Roles union, and for scope the **widest wins**: a person who is both a
   * salesperson (`own`) and a team lead (`team`) sees the team. Narrowing
   * instead would make adding a role reduce what someone can see, which is
   * not how anyone expects roles to behave.
   */
  async resolveScopes(
    roleIds: readonly string[],
    option?: TxOption,
  ): Promise<Record<string, ScopeLevel>> {
    const rules = await this.scopeRules.findForRoles(roleIds, option);
    const resolved: Record<string, ScopeLevel> = {};

    for (const rule of rules) {
      const current = resolved[rule.resource];
      const candidate = rule.scope;

      if (!current || SCOPE_RANK[candidate] > SCOPE_RANK[current]) {
        resolved[rule.resource] = candidate;
      }
    }

    return resolved;
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

  async replaceScopeRules(
    dto: ReplaceScopeRulesDto,
    actor: Principal,
  ): Promise<ScopeRule[]> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.scopeRules.findAll(option);
      const after = await this.scopeRules.upsertMany(
        dto.rules.map((rule) => ({
          roleId: rule.role_id,
          resource: rule.resource,
          scope: rule.scope,
        })),
        actor.userId,
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.SCOPE_RULE_UPDATED,
          companyId: actor.activeCompanyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'scope_rule',
          before: before.map((r) => ({
            roleId: r.roleId,
            resource: r.resource,
            scope: r.scope,
          })),
          after: after.map((r) => ({
            roleId: r.roleId,
            resource: r.resource,
            scope: r.scope,
          })),
        },
        option,
      );

      return after;
    });
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
