import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaTransactionService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  effectiveRule,
  NOTIFICATION_RULES,
  ruleOf,
  ruleProblems,
  type RuleDefinition,
  type RuleParams,
} from './notification-rules';
import { templateOf } from './notification-templates';

export interface NotificationRuleView {
  code: string;
  module: RuleDefinition['module'];
  label: string;
  description: string;
  recipients: string;
  events: { event_type: string; label: string }[];
  params: {
    key: string;
    label: string;
    kind: string;
    min: number;
    max: number;
    max_items: number | null;
  }[];
  standard: { enabled: true; params: RuleParams };
  enabled: boolean;
  values: RuleParams;
  /** False = the standard is in use (no row). */
  customized: boolean;
  updated_at: string | null;
}

/**
 * CD-53 — the admin side of reminder rules, per company. Same shape as the
 * templates (CD-54): configuration, so "back to standard" removes the row,
 * and every change is audited with the setting before and after.
 */
@Injectable()
export class NotificationRuleAdminService {
  constructor(
    private readonly tx: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async list(
    actor: Principal,
    companyId?: string,
  ): Promise<NotificationRuleView[]> {
    const target = resolveTargetCompany(actor, companyId);
    const rows = await this.tx.execute((prisma) =>
      prisma.notificationRule.findMany({ where: { companyId: target } }),
    );
    const own = new Map(rows.map((row) => [row.code, row]));
    return NOTIFICATION_RULES.map((definition) =>
      viewOf(definition, own.get(definition.code) ?? null),
    );
  }

  async save(
    code: string,
    dto: {
      enabled: boolean;
      params?: Record<string, unknown>;
      company_id?: string;
    },
    actor: Principal,
  ): Promise<NotificationRuleView> {
    const definition = this.definitionOf(code);
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const { problems, params } = ruleProblems(definition, dto.params ?? {});
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'params', reason })),
      );
    }

    return this.tx.execute(async (prisma) => {
      const key = { companyId_code: { companyId, code } };
      const before = await prisma.notificationRule.findUnique({ where: key });
      const json = params as unknown as Prisma.InputJsonValue;
      const row = await prisma.notificationRule.upsert({
        where: key,
        create: {
          companyId,
          code,
          enabled: dto.enabled,
          params: json,
          updatedBy: actor.userId,
        },
        update: { enabled: dto.enabled, params: json, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'notification.rule.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'notification_rule',
          resourceId: code,
          before: before
            ? { enabled: before.enabled, params: before.params }
            : { standard: true },
          after: { enabled: row.enabled, params: row.params },
        },
        { prisma },
      );
      return viewOf(definition, row);
    });
  }

  /** Back to the standard. Nothing to reset is not an error. */
  async reset(
    code: string,
    actor: Principal,
    companyId?: string,
  ): Promise<NotificationRuleView> {
    const definition = this.definitionOf(code);
    const target = resolveTargetCompany(actor, companyId);

    return this.tx.execute(async (prisma) => {
      const key = { companyId_code: { companyId: target, code } };
      const before = await prisma.notificationRule.findUnique({ where: key });
      if (before) {
        await prisma.notificationRule.delete({ where: key });
        await this.audit.record(
          {
            eventType: 'notification.rule.reset',
            companyId: target,
            ...auditActor(actor),
            resourceType: 'notification_rule',
            resourceId: code,
            before: { enabled: before.enabled, params: before.params },
            after: { standard: true },
          },
          { prisma },
        );
      }
      return viewOf(definition, null);
    });
  }

  private definitionOf(code: string): RuleDefinition {
    const definition = ruleOf(code);
    if (!definition) {
      throw new AppError('NOT_FOUND', 'ไม่พบกติกาแจ้งเตือนที่ระบุ', [
        { field: 'code', reason: code },
      ]);
    }
    return definition;
  }
}

function viewOf(
  definition: RuleDefinition,
  row: { enabled: boolean; params: unknown; updatedAt: Date } | null,
): NotificationRuleView {
  const effective = effectiveRule(definition, row);
  return {
    code: definition.code,
    module: definition.module,
    label: definition.label,
    description: definition.description,
    recipients: definition.recipients,
    events: definition.eventTypes.map((eventType) => ({
      event_type: eventType,
      label: templateOf(eventType)?.label ?? eventType,
    })),
    params: definition.params.map((param) => ({
      key: param.key,
      label: param.label,
      kind: param.kind,
      min: param.min,
      max: param.max,
      max_items: param.maxItems ?? null,
    })),
    standard: { enabled: true, params: { ...definition.defaults } },
    enabled: effective.enabled,
    values: effective.params,
    customized: row !== null,
    updated_at: row ? row.updatedAt.toISOString() : null,
  };
}
