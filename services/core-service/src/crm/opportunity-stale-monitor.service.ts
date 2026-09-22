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
import { CrmConfigRepository } from './segment.repositories';
import { NotificationsService } from '../notifications/notifications.service';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_STALE_DAYS = 14;
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
 * เงียบ = โอกาสการขายที่ยังเปิดอยู่และไม่มีกิจกรรมที่ *ทำเสร็จ* ภายใน
 * `crm_company_configs.staleOpportunityDays` วัน (ยังไม่เคยมีเลย = นับจากวันเปิด).
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
    private readonly configs: CrmConfigRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.staleSweepIntervalMs') ??
      DEFAULT_INTERVAL_MS;

    // `0` disables the sweep — tests and one-off scripts.
    if (interval <= 0) return;

    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a test — or an operator — can run it on demand. */
  async sweep(at = new Date()): Promise<{ alerted: number }> {
    const daysOf = await this.thresholds();
    const where = this.candidateWhere(at, daysOf);

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
      const days = daysOf.get(opportunity.companyId) ?? DEFAULT_STALE_DAYS;
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
   * One OR-branch per company that set its own threshold, plus one for
   * everybody still on the default. `0` = alerts off for that company.
   */
  private candidateWhere(
    at: Date,
    configured: Map<string, number>,
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

    for (const [companyId, days] of configured) {
      if (days > 0) branches.push({ companyId, ...quietSince(days) });
    }
    branches.push({
      companyId: { notIn: [...configured.keys()] },
      ...quietSince(DEFAULT_STALE_DAYS),
    });

    return {
      stage: { in: OPEN_STAGES },
      staleAlertedAt: null,
      AND: [{ OR: branches }],
    };
  }

  private async thresholds(): Promise<Map<string, number>> {
    const rows = (await this.configs.findMany({
      select: { companyId: true, staleOpportunityDays: true },
    })) as { companyId: string; staleOpportunityDays: number }[];
    return new Map(
      rows.map((row) => [row.companyId, row.staleOpportunityDays]),
    );
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
