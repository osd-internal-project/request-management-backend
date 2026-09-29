import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import {
  effectiveRule,
  ruleOf,
  type EffectiveRule,
  type RuleDefinition,
} from './notification-rules';

/** One rule across every company — what a sweep needs in one read. */
export interface RuleAcrossCompanies {
  /** Companies that saved their own setting. */
  byCompany: Map<string, EffectiveRule>;
  /** Everybody else. */
  standard: EffectiveRule;
  of(companyId: string): EffectiveRule;
}

/**
 * CD-53 — how a sweep learns a company's reminder rule. Read on every tick,
 * so a change on the admin screen applies from the next pass without a
 * restart.
 */
@Injectable()
export class NotificationRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async across(code: string): Promise<RuleAcrossCompanies> {
    const definition = this.definitionOf(code);
    const rows = await this.prisma.notificationRule.findMany({
      where: { code },
      select: { companyId: true, enabled: true, params: true },
    });
    const byCompany = new Map(
      rows.map((row) => [row.companyId, effectiveRule(definition, row)]),
    );
    const standard = effectiveRule(definition, null);
    return {
      byCompany,
      standard,
      of: (companyId) => byCompany.get(companyId) ?? standard,
    };
  }

  private definitionOf(code: string): RuleDefinition {
    const definition = ruleOf(code);
    if (!definition) throw new Error(`no notification rule ${code}`);
    return definition;
  }
}
