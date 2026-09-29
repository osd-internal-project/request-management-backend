import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpportunityStage, Prisma } from '@prisma/client';
import { AuditWriter } from '@request-management/share';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { OpportunityRepository } from './sales.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import type { RuleAcrossCompanies } from '../notifications/notification-rules.service';
import { backgroundTick } from '../common/background-tick';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OPEN_STAGES: OpportunityStage[] = [
  'qualifying',
  'proposing',
  'negotiating',
];

interface StaleCandidate {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
}

/**
 * CD-65 — "ดีลที่เงียบเกินกำหนดถูกแจ้งเตือนไปยังหัวหน้า".
 *
 * เงียบ = โอกาสการขายที่ยังเปิดอยู่และไม่มีกิจกรรมที่ *ทำเสร็จ* ภายในจำนวนวันของ
 * กติกา `opportunity.stale` ของบริษัท (CD-53; มาตรฐาน 14 วัน, ปิดกติกา = ไม่เตือน)
 * (ยังไม่เคยมีเลย = นับจากวันเปิด).
 * นัดที่ลงไว้แต่ยังไม่ได้ทำไม่นับ — นัดไม่ใช่ความเคลื่อนไหว.
 *
 * Same shape as `SlaMonitorService` (ผู้ใช้เลือก 18 ก.ย. 2569 ให้ทำใน core-service
 * แทน workflowable): a plain interval, `staleAlertedAt` as the guard against
 * repeat alerts, cleared by `OpportunityActivitiesService` when new work is
 * logged so a deal that goes quiet *again* is caught again.
 *
 * หัวหน้า = หัวหน้าหน่วยงานของเจ้าของดีล (`ownerOrgUnitId`) ไล่ขึ้นผังจนเจอ
 * คนที่ไม่ใช่เจ้าของเอง — หัวหน้าทีมที่ถือดีลเองต้องไปถึงคนเหนือขึ้นไป.
 */
@Injectable()
export class OpportunityStaleMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OpportunityStaleMonitorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.staleSweepIntervalMs') ??
      DEFAULT_INTERVAL_MS;

    // `0` disables the sweep — tests and one-off scripts.
    if (interval <= 0) return;

    this.timer = setInterval(
      backgroundTick(this.logger, 'stale-opportunity sweep', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a test — or an operator — can run it on demand. */
  async sweep(at = new Date()): Promise<{ alerted: number }> {
    const rule = await this.rules.across('opportunity.stale');
    const where = this.candidateWhere(at, rule);

    const found = (await this.opportunities.findMany({
      where,
      select: {
        id: true,
        companyId: true,
        opportunityCode: true,
        title: true,
        ownerUserId: true,
        ownerOrgUnitId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })) as StaleCandidate[];

    for (const opportunity of found) {
      const days = rule.of(opportunity.companyId).params.days as number;
      const head = await this.headOf(opportunity);
      const recipients = [
        ...new Set([opportunity.ownerUserId, head ?? '']),
      ].filter(Boolean);

      // Mark first: a notification that fails must not turn into one every
      // hour — `emit` already logs its own failures.
      await this.opportunities.update({
        where: { id: opportunity.id },
        data: { staleAlertedAt: at },
      });

      for (const userId of recipients) {
        await this.notifications.opportunityStale(
          userId,
          opportunity.companyId,
          opportunity,
          days,
        );
      }

      await this.audit.record({
        eventType: 'crm.opportunity.stale_alerted',
        companyId: opportunity.companyId,
        // No actor: the system acted, not a person.
        actorUsername: 'system',
        resourceType: 'opportunity',
        resourceId: opportunity.id,
        after: { recipients, days, at: at.toISOString() },
      });
    }

    if (found.length) {
      this.logger.warn(`CD-65: alerted ${found.length} stale opportunity(ies)`);
    }

    return { alerted: found.length };
  }

  /**
   * One OR-branch per company that set its own rule, plus one for everybody
   * still on the standard. A rule switched off adds no branch.
   */
  private candidateWhere(
    at: Date,
    rule: RuleAcrossCompanies,
  ): Prisma.OpportunityWhereInput {
    const branches: Prisma.OpportunityWhereInput[] = [];

    const quietSince = (days: number): Prisma.OpportunityWhereInput => {
      const cutoff = new Date(at.getTime() - days * DAY_MS);
      return {
        OR: [
          { lastActivityAt: { lt: cutoff } },
          { lastActivityAt: null, createdAt: { lt: cutoff } },
        ],
      };
    };

    for (const [companyId, own] of rule.byCompany) {
      if (own.enabled) {
        branches.push({ companyId, ...quietSince(own.params.days as number) });
      }
    }
    if (rule.standard.enabled) {
      branches.push({
        companyId: { notIn: [...rule.byCompany.keys()] },
        ...quietSince(rule.standard.params.days as number),
      });
    }

    return {
      stage: { in: OPEN_STAGES },
      staleAlertedAt: null,
      AND: [{ OR: branches }],
    };
  }

  /** Nearest head above the owner who is not the owner. */
  private async headOf(opportunity: StaleCandidate): Promise<string | null> {
    if (!opportunity.ownerOrgUnitId) return null;

    const ancestors = await this.orgUnits.ancestorIdsOf(
      opportunity.ownerOrgUnitId,
    );
    const heads = await this.orgUnits.managersOf(ancestors);

    return heads.find((userId) => userId !== opportunity.ownerUserId) ?? null;
  }
}
