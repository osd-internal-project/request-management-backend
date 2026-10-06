import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, hasPermission, Principal } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KbAiQueryRepository } from './kb-ai.repositories';
import {
  gapKey,
  isLowRated,
  remindDue,
  selfAnswerPct,
  thresholdsOf,
  type GapThresholds,
} from './kb-gap-rules';
import {
  KbArticleRepository,
  KbGapRepository,
  KbGapStatsRepository,
} from './kb.repositories';
import { KbService } from './kb.service';

const MANAGE = 'kb.article.manage';
const RULE = 'kb.gap';
const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_RETENTION_DAYS = 180;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const date = (s: string) => new Date(`${s}T00:00:00Z`);

interface GapRow {
  id: string;
  companyId: string;
  kind: string;
  key: string;
  title: string;
  detail: string | null;
  occurrences: number;
  articleId: string | null;
  articleVersion: number | null;
  baseYes: number;
  baseNo: number;
  status: string;
  assigneeId: string | null;
  dueOn: Date | null;
  assignedBy: string | null;
  assignedAt: Date | null;
  resolutionArticleId: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  dismissReason: string | null;
  remindedOn: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * CD-266 ช่องว่างความรู้ (part of CD-22 KBMS) — what the knowledge base is
 * missing, as a list for the team to fill:
 *
 * - questions AI channels could not answer (CD-265), the same question
 *   counted once;
 * - published articles readers found unhelpful (staff and Portal votes:
 *   at least `min_votes`, helpful under `helpful_percent`);
 * - staff searches that found nothing, once repeated `search_misses` times.
 *
 * A knowledge owner assigns a gap with a due day (the assignee is told; past
 * due, reminded every `overdue_days` — rule `kb.gap`, CD-53); the assignee
 * starts an article from it or links one; it closes when that article is
 * published — a low-rated one when its next version is. Owners may dismiss
 * with a reason. The monthly self-answer rate of the AI channels and the
 * gaps opened and closed show beside the list (and in the Data Mart).
 */
@Injectable()
export class KbGapService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbGapService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gaps: KbGapRepository,
    private readonly stats: KbGapStatsRepository,
    private readonly articles: KbArticleRepository,
    private readonly aiQueries: KbAiQueryRepository,
    private readonly kb: KbService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('kb.ingestIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-266 knowledge gaps', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- the list ---------------------------------------------------------------

  async list(
    actor: Principal,
    filter: { status?: string; kind?: string; mine?: boolean },
  ) {
    const manage = hasPermission(actor, MANAGE);
    const t = await this.thresholds(actor.activeCompanyId);
    const statuses = filter.status ? [filter.status] : ['open', 'assigned'];
    const rows = (await this.gaps.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: { in: statuses },
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(!manage || filter.mine ? { assigneeId: actor.userId } : {}),
      },
      orderBy: [{ occurrences: 'desc' }, { lastSeenAt: 'desc' }],
      take: 300,
    })) as GapRow[];
    const visible = rows.filter(
      (g) => g.kind !== 'search_miss' || g.occurrences >= t.searchMisses,
    );
    const articleIds = [
      ...new Set(
        visible
          .flatMap((g) => [g.articleId, g.resolutionArticleId])
          .filter((x): x is string => !!x),
      ),
    ];
    const articles = (await this.articles.findMany({
      where: { id: { in: articleIds } },
      select: {
        id: true,
        articleNo: true,
        title: true,
        status: true,
        helpfulYes: true,
        helpfulNo: true,
        portalHelpfulYes: true,
        portalHelpfulNo: true,
      },
    })) as {
      id: string;
      articleNo: string;
      title: string;
      status: string;
      helpfulYes: number;
      helpfulNo: number;
      portalHelpfulYes: number;
      portalHelpfulNo: number;
    }[];
    const people = await this.kb.peopleNames(
      visible.flatMap((g) => [g.assigneeId, g.resolvedBy]),
    );
    const today = thaiToday();
    return {
      canManage: manage,
      thresholds: t,
      items: visible.map((g) => {
        const article = articles.find((a) => a.id === g.articleId) ?? null;
        const resolution =
          articles.find((a) => a.id === g.resolutionArticleId) ?? null;
        return {
          id: g.id,
          kind: g.kind,
          title: g.title,
          detail: g.detail,
          occurrences: g.occurrences,
          status: g.status,
          firstSeenAt: g.firstSeenAt,
          lastSeenAt: g.lastSeenAt,
          article: article
            ? {
                id: article.id,
                articleNo: article.articleNo,
                title: article.title,
                votes:
                  article.helpfulYes +
                  article.helpfulNo +
                  article.portalHelpfulYes +
                  article.portalHelpfulNo,
                helpful: article.helpfulYes + article.portalHelpfulYes,
              }
            : null,
          assignee: g.assigneeId
            ? (people.get(g.assigneeId) ?? g.assigneeId)
            : null,
          assigneeId: g.assigneeId,
          dueOn: day(g.dueOn),
          overdue:
            g.status === 'assigned' && !!g.dueOn && day(g.dueOn)! < today,
          resolution: resolution
            ? {
                id: resolution.id,
                articleNo: resolution.articleNo,
                title: resolution.title,
                status: resolution.status,
              }
            : null,
          resolvedAt: g.resolvedAt,
          resolvedBy: g.resolvedBy
            ? (people.get(g.resolvedBy) ?? g.resolvedBy)
            : null,
          dismissReason: g.dismissReason,
          canWork: manage || g.assigneeId === actor.userId,
        };
      }),
    };
  }

  /** Monthly self-answer rate (by channel) and gaps opened / closed. */
  async monthly(actor: Principal) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ดูตัวเลขได้เฉพาะผู้ดูแลคลังความรู้');
    // a day early so the first Bangkok month is whole
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 11, 0);
    since.setUTCHours(0, 0, 0, 0);
    const [ai, gaps] = await Promise.all([
      this.stats.aiMonthly(actor.activeCompanyId, since),
      this.stats.gapsMonthly(actor.activeCompanyId, since),
    ]);
    // Bangkok months, the same as the SQL buckets
    const [y, mo] = thaiToday().split('-').map(Number);
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const m = new Date(Date.UTC(y, mo - 1 - i, 1));
      months.push(m.toISOString().slice(0, 7));
    }
    const count = (month: string, channel: string | null, outcome: string) =>
      ai
        .filter(
          (r) =>
            r.month === month &&
            r.outcome === outcome &&
            (!channel || r.channel === channel),
        )
        .reduce((s, r) => s + r.n, 0);
    return months.map((month) => {
      const answered = count(month, null, 'answered');
      const unanswered = count(month, null, 'unanswered');
      const g = gaps.find((r) => r.month === month);
      return {
        month,
        searches: answered + unanswered + count(month, null, 'pending'),
        answered,
        unanswered,
        selfAnswerPct: selfAnswerPct(answered, unanswered),
        byChannel: ['ai_care', 'ai_smart'].map((channel) => ({
          channel,
          selfAnswerPct: selfAnswerPct(
            count(month, channel, 'answered'),
            count(month, channel, 'unanswered'),
          ),
        })),
        gapsOpened: g?.opened ?? 0,
        gapsResolved: g?.resolved ?? 0,
      };
    });
  }

  // --- working a gap ----------------------------------------------------------

  async assign(
    actor: Principal,
    id: string,
    assigneeId: string,
    dueOn: string,
  ) {
    this.assertManage(actor);
    const gap = await this.gap(actor, id);
    if (gap.status === 'resolved' || gap.status === 'dismissed')
      throw new AppError('CONFLICT', 'ช่องว่างนี้ปิดไปแล้ว');
    if (dueOn < thaiToday()) invalid('กำหนดส่งต้องไม่ก่อนวันนี้');
    await this.gaps.update({
      where: { id },
      data: {
        status: 'assigned',
        assigneeId,
        dueOn: date(dueOn),
        assignedBy: actor.userId,
        assignedAt: new Date(),
        remindedOn: null,
      },
    });
    if (assigneeId !== actor.userId) {
      await this.notifications.kbGap(
        assigneeId,
        gap.companyId,
        gap,
        dueOn,
        'assigned',
      );
    }
    return { id };
  }

  /** A draft article from the gap, owned by whoever fills it. */
  async startArticle(actor: Principal, id: string) {
    const gap = await this.workable(actor, id);
    if (gap.resolutionArticleId) {
      throw new AppError(
        'CONFLICT',
        'ช่องว่างนี้มีบทความที่กำลังเติมอยู่แล้ว',
        [{ field: 'articleId', reason: gap.resolutionArticleId }],
      );
    }
    const lines =
      gap.kind === 'low_rated'
        ? [
            '> ช่องว่าง: บทความเดิมถูกให้คะแนนว่าไม่ช่วย — เขียนให้ตอบได้ดีขึ้น',
            '',
          ]
        : [
            `> ช่องว่าง: ${gap.kind === 'ai_unanswered' ? 'คำถามที่ AI ตอบไม่ได้' : 'คำค้นที่ไม่เจอบทความ'} (${gap.occurrences} ครั้ง)`,
            '',
            '## คำถาม',
            gap.detail ?? gap.title,
            '',
            '## คำตอบ',
            '',
          ];
    const article = await this.kb.insertDraft(gap.companyId, actor.userId, {
      title: gap.title.slice(0, 200),
      body: lines.join('\n'),
    });
    await this.gaps.update({
      where: { id },
      data: {
        resolutionArticleId: article.id,
        ...(gap.status === 'open'
          ? { status: 'assigned', assigneeId: actor.userId }
          : {}),
      },
    });
    return { articleId: article.id, articleNo: article.articleNo };
  }

  /** Fill it with an existing article (closes now if already published). */
  async link(actor: Principal, id: string, articleId: string) {
    const gap = await this.workable(actor, id);
    const article = (await this.articles.findFirst({
      where: { id: articleId, companyId: gap.companyId },
      select: { id: true, status: true },
    })) as { id: string; status: string } | null;
    if (!article) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    await this.gaps.update({
      where: { id },
      data: {
        resolutionArticleId: article.id,
        ...(article.status === 'published'
          ? {
              status: 'resolved',
              resolvedAt: new Date(),
              resolvedBy: actor.userId,
            }
          : gap.status === 'open'
            ? { status: 'assigned', assigneeId: actor.userId }
            : {}),
      },
    });
    return { id, resolved: article.status === 'published' };
  }

  async dismiss(actor: Principal, id: string, reason: string) {
    this.assertManage(actor);
    if (!reason.trim()) invalid('ต้องระบุเหตุผลที่ปิดทิ้ง');
    const gap = await this.gap(actor, id);
    if (gap.status === 'resolved' || gap.status === 'dismissed')
      throw new AppError('CONFLICT', 'ช่องว่างนี้ปิดไปแล้ว');
    await this.gaps.update({
      where: { id },
      data: {
        status: 'dismissed',
        dismissReason: reason.trim(),
        resolvedAt: new Date(),
        resolvedBy: actor.userId,
      },
    });
    return { id };
  }

  /** A staff search that found nothing (keyword searches only). */
  async recordSearchMiss(companyId: string, query: string) {
    const key = gapKey(query);
    if (key.length < 2) return;
    await this.bump(
      companyId,
      'search_miss',
      key,
      query.trim().slice(0, 200),
      null,
    );
  }

  // --- the sweep --------------------------------------------------------------

  async sweep(now: Date = new Date()) {
    const result = { unanswered: 0, lowRated: 0, resolved: 0, reminded: 0 };
    const rule = await this.rules.across(RULE);
    const today = thaiToday(now);

    // 1. questions AI channels could not answer
    const missed = (await this.aiQueries.findMany({
      where: { outcome: 'unanswered', gapId: null, question: { not: null } },
      select: { id: true, companyId: true, question: true },
      take: 500,
    })) as { id: string; companyId: string; question: string }[];
    for (const q of missed) {
      const key = gapKey(q.question);
      if (!key) continue;
      const gapId = await this.bump(
        q.companyId,
        'ai_unanswered',
        key,
        q.question.slice(0, 200),
        q.question,
      );
      await this.aiQueries.update({ where: { id: q.id }, data: { gapId } });
      result.unanswered += 1;
    }

    // 2. articles readers found unhelpful
    const rated = (await this.articles.findMany({
      where: { status: 'published', mergedIntoId: null },
      select: {
        id: true,
        companyId: true,
        title: true,
        version: true,
        helpfulYes: true,
        helpfulNo: true,
        portalHelpfulYes: true,
        portalHelpfulNo: true,
      },
    })) as {
      id: string;
      companyId: string;
      title: string;
      version: number;
      helpfulYes: number;
      helpfulNo: number;
      portalHelpfulYes: number;
      portalHelpfulNo: number;
    }[];
    const lowGaps = (await this.gaps.findMany({
      where: { kind: 'low_rated' },
    })) as GapRow[];
    for (const a of rated) {
      const t = thresholdsOf(rule.of(a.companyId).params);
      const yes = a.helpfulYes + a.portalHelpfulYes;
      const no = a.helpfulNo + a.portalHelpfulNo;
      const gap = lowGaps.find(
        (g) => g.companyId === a.companyId && g.key === a.id,
      );
      // only votes since the gap last closed count
      const low = isLowRated(
        yes - (gap?.baseYes ?? 0),
        no - (gap?.baseNo ?? 0),
        t,
      );
      const live = gap && (gap.status === 'open' || gap.status === 'assigned');
      if (low && !live) {
        if (gap?.status === 'dismissed' && gap.articleVersion === a.version)
          continue;
        await this.openLowRated(a, gap ?? null);
        result.lowRated += 1;
      } else if (live && (!low || (gap.articleVersion ?? 0) < a.version)) {
        // rated back up, or a new version went up: filled — and votes start afresh
        await this.gaps.update({
          where: { id: gap.id },
          data: {
            status: 'resolved',
            resolvedAt: now,
            resolutionArticleId: gap.resolutionArticleId ?? a.id,
            baseYes: yes,
            baseNo: no,
          },
        });
        result.resolved += 1;
      }
    }

    // 3. filled by an article now published
    const pending = (await this.gaps.findMany({
      where: {
        status: { in: ['open', 'assigned'] },
        resolutionArticleId: { not: null },
        kind: { not: 'low_rated' },
      },
      select: { id: true, resolutionArticleId: true },
    })) as { id: string; resolutionArticleId: string }[];
    if (pending.length) {
      const published = (await this.articles.findMany({
        where: {
          id: { in: pending.map((p) => p.resolutionArticleId) },
          status: 'published',
        },
        select: { id: true },
      })) as { id: string }[];
      for (const p of pending.filter((x) =>
        published.some((a) => a.id === x.resolutionArticleId),
      )) {
        await this.gaps.update({
          where: { id: p.id },
          data: { status: 'resolved', resolvedAt: now },
        });
        result.resolved += 1;
      }
    }

    // 4. assignees past due
    const assigned = (await this.gaps.findMany({
      where: {
        status: 'assigned',
        assigneeId: { not: null },
        dueOn: { lt: date(today) },
      },
    })) as GapRow[];
    for (const g of assigned) {
      const own = rule.of(g.companyId);
      if (!own.enabled) continue;
      const t = thresholdsOf(own.params);
      if (!remindDue(day(g.dueOn), day(g.remindedOn), today, t.overdueDays))
        continue;
      await this.gaps.update({
        where: { id: g.id },
        data: { remindedOn: date(today) },
      });
      await this.notifications.kbGap(
        g.assigneeId!,
        g.companyId,
        g,
        day(g.dueOn)!,
        'overdue',
      );
      result.reminded += 1;
    }

    // 5. closed AI gaps past retention lose the customer's wording
    const retention =
      this.config.get<number>('kb.aiRetentionDays') ?? DEFAULT_RETENTION_DAYS;
    await this.gaps.updateMany({
      where: {
        kind: 'ai_unanswered',
        status: { in: ['resolved', 'dismissed'] },
        lastSeenAt: { lt: new Date(now.getTime() - retention * 86_400_000) },
        detail: { not: null },
      },
      data: { detail: null, title: '(ข้อความถูกลบตามระยะเก็บ)' },
    });
    return result;
  }

  // --- helpers ----------------------------------------------------------------

  /** One more of the same: count it, reopening a gap filled before. */
  private async bump(
    companyId: string,
    kind: string,
    key: string,
    title: string,
    detail: string | null,
  ) {
    const existing = (await this.gaps.findUnique({
      where: { companyId_kind_key: { companyId, kind, key } },
    })) as GapRow | null;
    if (!existing) {
      const row = (await this.gaps.create({
        data: { companyId, kind, key, title, detail },
      })) as { id: string };
      return row.id;
    }
    await this.gaps.update({
      where: { id: existing.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        ...(detail ? { detail } : {}),
        // answered by an article that still does not answer it: open again
        ...(existing.status === 'resolved'
          ? {
              status: 'open',
              resolvedAt: null,
              resolvedBy: null,
              assigneeId: null,
              dueOn: null,
              resolutionArticleId: null,
            }
          : {}),
      },
    });
    return existing.id;
  }

  private async openLowRated(
    a: { id: string; companyId: string; title: string; version: number },
    existing: GapRow | null,
  ) {
    const data = {
      title: a.title,
      articleId: a.id,
      articleVersion: a.version,
      status: 'open',
      assigneeId: null,
      dueOn: null,
      resolutionArticleId: null,
      resolvedAt: null,
      resolvedBy: null,
      dismissReason: null,
      lastSeenAt: new Date(),
    };
    if (existing) {
      await this.gaps.update({
        where: { id: existing.id },
        data: { ...data, occurrences: { increment: 1 } },
      });
    } else {
      await this.gaps.create({
        data: { ...data, companyId: a.companyId, kind: 'low_rated', key: a.id },
      });
    }
  }

  private async thresholds(companyId: string): Promise<GapThresholds> {
    const rule = await this.rules.across(RULE);
    return thresholdsOf(rule.of(companyId).params);
  }

  private async gap(actor: Principal, id: string) {
    const row = (await this.gaps.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as GapRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบช่องว่างที่ระบุ');
    return row;
  }

  private async workable(actor: Principal, id: string) {
    const gap = await this.gap(actor, id);
    if (gap.status === 'resolved' || gap.status === 'dismissed')
      throw new AppError('CONFLICT', 'ช่องว่างนี้ปิดไปแล้ว');
    if (!hasPermission(actor, MANAGE) && gap.assigneeId !== actor.userId)
      throw new AppError(
        'FORBIDDEN',
        'เติมได้เฉพาะผู้ที่ได้รับมอบหมายหรือผู้ดูแลคลังความรู้',
      );
    return gap;
  }

  private assertManage(actor: Principal) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ทำได้เฉพาะผู้ดูแลคลังความรู้');
  }
}

function invalid(reason: string): never {
  throw new AppError('VALIDATION_FAILED', reason, [{ field: 'body', reason }]);
}
