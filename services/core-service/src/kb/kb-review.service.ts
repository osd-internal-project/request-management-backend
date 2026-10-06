import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { KbArticle, KbArticleRevision } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  Principal,
  PrismaService,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  addMonths,
  articleProblems,
  audienceCustomers,
  audienceProblems,
  MAX_CHANGE_NOTE,
  normalizeTags,
  OPEN_REVISION,
  publishProblems,
  reviewMonthsOf,
  union,
} from './kb-rules';
import { KbService, type SaveArticle } from './kb.service';

const MANAGE = 'kb.article.manage';
const RULE = 'kb.review';
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const date = (value: string) => new Date(`${value}T00:00:00Z`);

type Tx = Prisma.TransactionClient;

interface Content {
  title: string;
  summary: string | null;
  body: string;
  categoryId: string | null;
  tags: string[];
  productCodes: string[];
  productGroups: string[];
  audience: string;
  customerIds: string[];
}

/**
 * CD-260 กลั่นกรองและอนุมัติ (part of CD-22 KBMS) — nothing reaches readers
 * without a knowledge owner's say:
 *
 * - a first draft is sent for review (in_review); a knowledge owner
 *   (`kb.article.manage`) approves it — version 1 goes up — or sends it back
 *   with a note;
 * - a published article is reworked as a revision while the published text
 *   stays up; approving it replaces the text as the next version;
 * - every version keeps its text, writer, approver and day;
 * - each article has an owner (its author at first) who answers for it: its
 *   category's review interval (else the parent's, else 12 months) counts
 *   from each approval or review; the `kb.review` rule (CD-53) reminds the
 *   owner `days` before; the owner confirms it still holds, or reworks it;
 * - a duplicate is merged into the main article: archived, readers sent on,
 *   its tags, products, views and readers' votes carried over.
 */
@Injectable()
export class KbReviewService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbReviewService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly kb: KbService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('kb.reviewIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-260 knowledge review reminder', () =>
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

  // --- first drafts -----------------------------------------------------------

  /** The author (or an owner) sends a first draft for review. */
  async submit(actor: Principal, id: string) {
    const row = await this.article(actor, id);
    if (row.status !== 'draft')
      throw new AppError('CONFLICT', 'ส่งตรวจได้เฉพาะฉบับร่าง');
    if (row.authorId !== actor.userId && !hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ส่งตรวจได้เฉพาะผู้เขียน');
    const problems = publishProblems(row);
    if (problems.length) throw invalid(problems);
    await this.prisma.kbArticle.update({
      where: { id },
      data: { status: 'in_review', submittedAt: new Date(), reviewNote: null },
    });
    await this.record(actor, row.companyId, 'kb.article.submitted', id, {});
    await this.tellOwners(
      row.companyId,
      actor.userId,
      row.articleNo,
      row.title,
      id,
      'requested',
    );
    return { id };
  }

  /** The writer takes a draft or a revision back from review to change it. */
  async withdraw(actor: Principal, id: string, revisionId?: string) {
    if (revisionId) {
      const rev = await this.revision(actor, id, revisionId);
      if (rev.status !== 'in_review')
        throw new AppError('CONFLICT', 'ไม่ได้อยู่ระหว่างรอตรวจ');
      this.assertWriter(actor, rev.createdBy);
      await this.prisma.kbArticleRevision.update({
        where: { id: revisionId },
        data: { status: 'draft', submittedAt: null },
      });
      return { id };
    }
    const row = await this.article(actor, id);
    if (row.status !== 'in_review')
      throw new AppError('CONFLICT', 'ไม่ได้อยู่ระหว่างรอตรวจ');
    this.assertWriter(actor, row.authorId);
    await this.prisma.kbArticle.update({
      where: { id },
      data: { status: 'draft', submittedAt: null },
    });
    return { id };
  }

  // --- revisions ---------------------------------------------------------------

  /** Opens a reworking of a published article (its owner, author or an owner). */
  async openRevision(actor: Principal, id: string) {
    const row = await this.article(actor, id);
    if (row.status !== 'published')
      throw new AppError(
        'CONFLICT',
        'เปิดฉบับปรับปรุงได้เฉพาะบทความที่เผยแพร่อยู่',
      );
    if (
      !hasPermission(actor, MANAGE) &&
      actor.userId !== row.ownerId &&
      actor.userId !== row.authorId
    ) {
      throw new AppError(
        'FORBIDDEN',
        'ปรับปรุงได้เฉพาะเจ้าของบทความ ผู้เขียน หรือผู้ดูแลคลังความรู้',
      );
    }
    const open = await this.openRevisionOf(id);
    if (open) {
      throw new AppError('CONFLICT', 'มีฉบับปรับปรุงที่ยังไม่ปิดอยู่แล้ว', [
        { field: 'revisionId', reason: open.id },
      ]);
    }
    const rev = await this.prisma.kbArticleRevision.create({
      data: {
        articleId: id,
        title: row.title,
        summary: row.summary,
        body: row.body,
        categoryId: row.categoryId,
        tags: row.tags,
        productCodes: row.productCodes,
        productGroups: row.productGroups,
        audience: row.audience,
        customerIds: row.customerIds,
        createdBy: actor.userId,
      },
    });
    await this.record(actor, row.companyId, 'kb.revision.opened', id, {
      revisionId: rev.id,
    });
    return this.revisionView(actor, id, rev.id);
  }

  async revisionView(actor: Principal, id: string, revisionId: string) {
    const rev = await this.revision(actor, id, revisionId);
    const names = await this.people([rev.createdBy, rev.reviewedBy]);
    return {
      id: rev.id,
      articleId: id,
      status: rev.status,
      title: rev.title,
      summary: rev.summary,
      body: rev.body,
      categoryId: rev.categoryId,
      tags: rev.tags,
      productCodes: rev.productCodes,
      productGroups: rev.productGroups,
      audience: rev.audience,
      customerIds: rev.customerIds,
      changeNote: rev.changeNote,
      createdBy: names.get(rev.createdBy) ?? rev.createdBy,
      createdAt: rev.createdAt,
      submittedAt: rev.submittedAt,
      reviewedBy: rev.reviewedBy ? (names.get(rev.reviewedBy) ?? null) : null,
      reviewedAt: rev.reviewedAt,
      reviewNote: rev.reviewNote,
      canEdit:
        (rev.status === 'draft' || rev.status === 'returned') &&
        (rev.createdBy === actor.userId || hasPermission(actor, MANAGE)),
      canReview: rev.status === 'in_review' && hasPermission(actor, MANAGE),
    };
  }

  async updateRevision(
    actor: Principal,
    id: string,
    revisionId: string,
    input: SaveArticle & { changeNote?: string },
  ) {
    const rev = await this.revision(actor, id, revisionId);
    if (rev.status !== 'draft' && rev.status !== 'returned')
      throw new AppError('CONFLICT', 'แก้ได้เฉพาะฉบับปรับปรุงที่ยังไม่ส่งตรวจ');
    this.assertWriter(actor, rev.createdBy);
    const content = await this.clean(actor.activeCompanyId, input);
    await this.prisma.kbArticleRevision.update({
      where: { id: revisionId },
      data: {
        ...content,
        changeNote: (input.changeNote ?? rev.changeNote).trim(),
      },
    });
    return this.revisionView(actor, id, revisionId);
  }

  async submitRevision(actor: Principal, id: string, revisionId: string) {
    const rev = await this.revision(actor, id, revisionId);
    if (rev.status !== 'draft' && rev.status !== 'returned')
      throw new AppError('CONFLICT', 'ส่งตรวจได้เฉพาะฉบับปรับปรุงที่ยังไม่ส่ง');
    this.assertWriter(actor, rev.createdBy);
    const problems = publishProblems(rev);
    if (!rev.changeNote.trim()) problems.push('ต้องระบุว่าแก้อะไร');
    if (problems.length) throw invalid(problems);
    const row = await this.article(actor, id);
    await this.prisma.kbArticleRevision.update({
      where: { id: revisionId },
      data: { status: 'in_review', submittedAt: new Date() },
    });
    await this.record(actor, row.companyId, 'kb.revision.submitted', id, {
      revisionId,
    });
    await this.tellOwners(
      row.companyId,
      actor.userId,
      row.articleNo,
      row.title,
      id,
      'requested',
    );
    return this.revisionView(actor, id, revisionId);
  }

  async discardRevision(actor: Principal, id: string, revisionId: string) {
    const rev = await this.revision(actor, id, revisionId);
    if (!(OPEN_REVISION as readonly string[]).includes(rev.status))
      throw new AppError('CONFLICT', 'ฉบับปรับปรุงนี้ปิดไปแล้ว');
    this.assertWriter(actor, rev.createdBy);
    await this.prisma.kbArticleRevision.update({
      where: { id: revisionId },
      data: { status: 'discarded' },
    });
    return { id };
  }

  // --- approval ---------------------------------------------------------------

  /**
   * A knowledge owner approves: a first draft (in review, or straight from a
   * draft), or a revision in review. The text goes up as the next version.
   */
  async approve(
    actor: Principal,
    id: string,
    revisionId?: string,
    note?: string,
  ) {
    this.assertOwner(actor);
    const row = await this.article(actor, id);
    if (revisionId) {
      const rev = await this.revision(actor, id, revisionId);
      if (rev.status !== 'in_review')
        throw new AppError(
          'CONFLICT',
          'อนุมัติได้เฉพาะฉบับปรับปรุงที่ส่งตรวจแล้ว',
        );
      if (row.status !== 'published')
        throw new AppError('CONFLICT', 'บทความต้นทางไม่ได้เผยแพร่อยู่');
      const problems = publishProblems(rev);
      if (problems.length) throw invalid(problems);
      await this.prisma.$transaction(async (tx) => {
        await this.publishVersion(
          tx,
          actor,
          row,
          rev,
          rev.createdBy,
          rev.changeNote,
        );
        await tx.kbArticleRevision.update({
          where: { id: revisionId },
          data: {
            status: 'approved',
            reviewedBy: actor.userId,
            reviewedAt: new Date(),
            reviewNote: note?.trim() || null,
          },
        });
      });
      await this.record(actor, row.companyId, 'kb.revision.approved', id, {
        revisionId,
        version: row.version + 1,
      });
      if (rev.createdBy !== actor.userId) {
        await this.notifications.kbReview(
          rev.createdBy,
          row.companyId,
          row,
          'approved',
          note ?? '',
        );
      }
      return { id, version: row.version + 1 };
    }
    if (row.status !== 'draft' && row.status !== 'in_review')
      throw new AppError(
        'CONFLICT',
        'อนุมัติได้เฉพาะฉบับร่างหรือที่ส่งตรวจแล้ว',
      );
    const problems = publishProblems(row);
    if (problems.length) throw invalid(problems);
    await this.prisma.$transaction(async (tx) => {
      await this.publishVersion(
        tx,
        actor,
        row,
        row,
        row.authorId,
        note?.trim() ?? '',
      );
    });
    await this.record(actor, row.companyId, 'kb.article.published', id, {
      articleNo: row.articleNo,
      version: row.version + 1,
    });
    if (row.authorId !== actor.userId) {
      await this.notifications.kbReview(
        row.authorId,
        row.companyId,
        row,
        'approved',
        note ?? '',
      );
    }
    return { id, version: row.version + 1 };
  }

  /** A knowledge owner sends a draft or revision back, saying what to fix. */
  async sendBack(
    actor: Principal,
    id: string,
    note: string,
    revisionId?: string,
  ) {
    this.assertOwner(actor);
    if (!note.trim()) throw invalid(['ต้องระบุสิ่งที่ต้องแก้']);
    const row = await this.article(actor, id);
    let writer: string;
    if (revisionId) {
      const rev = await this.revision(actor, id, revisionId);
      if (rev.status !== 'in_review')
        throw new AppError('CONFLICT', 'ไม่ได้อยู่ระหว่างรอตรวจ');
      await this.prisma.kbArticleRevision.update({
        where: { id: revisionId },
        data: {
          status: 'returned',
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewNote: note.trim(),
        },
      });
      writer = rev.createdBy;
    } else {
      if (row.status !== 'in_review')
        throw new AppError('CONFLICT', 'ไม่ได้อยู่ระหว่างรอตรวจ');
      await this.prisma.kbArticle.update({
        where: { id },
        data: {
          status: 'draft',
          reviewNote: note.trim(),
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
        },
      });
      writer = row.authorId;
    }
    await this.record(actor, row.companyId, 'kb.review.returned', id, {
      revisionId: revisionId ?? null,
      note: note.trim(),
    });
    if (writer !== actor.userId) {
      await this.notifications.kbReview(
        writer,
        row.companyId,
        row,
        'returned',
        note.trim(),
      );
    }
    return { id };
  }

  /** What waits for knowledge owners, and what is coming up for review. */
  async queue(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const manage = hasPermission(actor, MANAGE);
    const [drafts, revisions, due] = await Promise.all([
      manage
        ? this.prisma.kbArticle.findMany({
            where: { companyId, status: 'in_review' },
            orderBy: { submittedAt: 'asc' },
          })
        : Promise.resolve([] as KbArticle[]),
      manage
        ? this.prisma.kbArticleRevision.findMany({
            where: { status: 'in_review' },
            orderBy: { submittedAt: 'asc' },
          })
        : Promise.resolve([] as KbArticleRevision[]),
      this.prisma.kbArticle.findMany({
        where: {
          companyId,
          status: 'published',
          nextReviewOn: { lte: date(addDays(thaiToday(), 30)) },
          ...(manage ? {} : { ownerId: actor.userId }),
        },
        orderBy: { nextReviewOn: 'asc' },
        take: 200,
      }),
    ]);
    const revArticles = await this.prisma.kbArticle.findMany({
      where: { id: { in: revisions.map((r) => r.articleId) }, companyId },
      select: { id: true, articleNo: true, title: true },
    });
    const names = await this.people([
      ...drafts.map((d) => d.authorId),
      ...revisions.map((r) => r.createdBy),
      ...due.map((d) => d.ownerId),
    ]);
    return {
      canReview: manage,
      pending: [
        ...drafts.map((d) => ({
          kind: 'new' as const,
          articleId: d.id,
          revisionId: null,
          articleNo: d.articleNo,
          title: d.title,
          writer: names.get(d.authorId) ?? d.authorId,
          submittedAt: d.submittedAt,
          changeNote: null,
        })),
        ...revisions.flatMap((r) => {
          const a = revArticles.find((x) => x.id === r.articleId);
          return a
            ? [
                {
                  kind: 'revision' as const,
                  articleId: a.id,
                  revisionId: r.id,
                  articleNo: a.articleNo,
                  title: r.title,
                  writer: names.get(r.createdBy) ?? r.createdBy,
                  submittedAt: r.submittedAt,
                  changeNote: r.changeNote,
                },
              ]
            : [];
        }),
      ],
      dueReview: due.map((d) => ({
        articleId: d.id,
        articleNo: d.articleNo,
        title: d.title,
        owner: d.ownerId ? (names.get(d.ownerId) ?? d.ownerId) : null,
        nextReviewOn: day(d.nextReviewOn),
      })),
    };
  }

  // --- versions ---------------------------------------------------------------

  async versions(actor: Principal, id: string) {
    await this.article(actor, id);
    const rows = await this.prisma.kbArticleVersion.findMany({
      where: { articleId: id },
      orderBy: { version: 'desc' },
    });
    const names = await this.people(
      rows.flatMap((r) => [r.writtenBy, r.approvedBy]),
    );
    return rows.map((r) => ({
      version: r.version,
      title: r.title,
      changeNote: r.changeNote,
      writtenBy: names.get(r.writtenBy) ?? r.writtenBy,
      approvedBy: names.get(r.approvedBy) ?? r.approvedBy,
      approvedAt: r.approvedAt,
    }));
  }

  async version(actor: Principal, id: string, version: number) {
    await this.article(actor, id);
    const row = await this.prisma.kbArticleVersion.findUnique({
      where: { articleId_version: { articleId: id, version } },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    return {
      version: row.version,
      title: row.title,
      summary: row.summary,
      body: row.body,
      tags: row.tags,
      productCodes: row.productCodes,
      productGroups: row.productGroups,
      audience: row.audience,
      changeNote: row.changeNote,
      approvedAt: row.approvedAt,
    };
  }

  // --- owner and review -------------------------------------------------------

  async setOwner(actor: Principal, id: string, userId: string) {
    const row = await this.article(actor, id);
    if (!hasPermission(actor, MANAGE) && actor.userId !== row.ownerId)
      throw new AppError(
        'FORBIDDEN',
        'เปลี่ยนเจ้าของได้เฉพาะเจ้าของปัจจุบันหรือผู้ดูแลคลังความรู้',
      );
    const member = await this.prisma.userRole.findFirst({
      where: { userId, companyId: row.companyId },
      select: { userId: true },
    });
    if (!member)
      throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุในบริษัทนี้');
    await this.prisma.kbArticle.update({
      where: { id },
      data: { ownerId: userId },
    });
    await this.record(actor, row.companyId, 'kb.article.owner_changed', id, {
      from: row.ownerId,
      to: userId,
    });
    return { id };
  }

  /** The owner (or a knowledge owner) confirms the article still holds. */
  async confirmReview(actor: Principal, id: string, note?: string) {
    const row = await this.article(actor, id);
    if (row.status !== 'published')
      throw new AppError('CONFLICT', 'ทบทวนได้เฉพาะบทความที่เผยแพร่อยู่');
    if (!hasPermission(actor, MANAGE) && actor.userId !== row.ownerId)
      throw new AppError(
        'FORBIDDEN',
        'ทบทวนได้เฉพาะเจ้าของบทความหรือผู้ดูแลคลังความรู้',
      );
    const next = addMonths(thaiToday(), await this.monthsFor(row.categoryId));
    await this.prisma.kbArticle.update({
      where: { id },
      data: {
        lastReviewedAt: new Date(),
        lastReviewedBy: actor.userId,
        nextReviewOn: date(next),
        reviewRemindedOn: null,
      },
    });
    await this.record(actor, row.companyId, 'kb.article.reviewed', id, {
      nextReviewOn: next,
      note: note?.trim() ?? '',
    });
    return { id, nextReviewOn: next };
  }

  /** Reminds owners `days` before their articles come up for review (once each). */
  async sweep(now: Date = new Date()): Promise<{ reminded: number }> {
    const rule = await this.rules.across(RULE);
    if (![rule.standard, ...rule.byCompany.values()].some((r) => r.enabled))
      return { reminded: 0 };
    const today = thaiToday(now);
    const rows = await this.prisma.kbArticle.findMany({
      where: {
        status: 'published',
        nextReviewOn: { not: null, lte: date(addDays(today, 90)) },
      },
    });
    let reminded = 0;
    const owners = new Map<string, string[]>();
    for (const row of rows) {
      const own = rule.of(row.companyId);
      if (!own.enabled) continue;
      const days = typeof own.params.days === 'number' ? own.params.days : 14;
      const next = day(row.nextReviewOn)!;
      if (next > addDays(today, days)) continue;
      if (row.reviewRemindedOn && day(row.reviewRemindedOn) === next) continue;
      const claimed = await this.prisma.kbArticle.updateMany({
        where: { id: row.id, reviewRemindedOn: row.reviewRemindedOn },
        data: { reviewRemindedOn: date(next) },
      });
      if (!claimed.count) continue;
      let recipients = row.ownerId ? [row.ownerId] : [];
      if (row.ownerId) {
        const active = await this.prisma.userRole.count({
          where: { userId: row.ownerId, companyId: row.companyId },
        });
        if (!active) recipients = [];
      }
      if (!recipients.length) {
        if (!owners.has(row.companyId))
          owners.set(row.companyId, await this.owners(row.companyId));
        recipients = owners.get(row.companyId)!;
      }
      for (const userId of recipients) {
        await this.notifications.kbReviewDue(userId, row.companyId, row, next);
      }
      reminded += 1;
    }
    return { reminded };
  }

  /**
   * CD-261 — a knowledge owner takes an article out of the Portal at once (a
   * slip): it becomes internal as a new version, without waiting for a
   * revision to go through review.
   */
  async withdrawFromCustomers(actor: Principal, id: string, reason: string) {
    this.assertOwner(actor);
    if (!reason.trim()) throw invalid(['ต้องระบุเหตุผลที่ถอนจากลูกค้า']);
    const row = await this.article(actor, id);
    if (row.status !== 'published' || row.audience === 'internal')
      throw new AppError('CONFLICT', 'บทความนี้ไม่ได้เผยแพร่ให้ลูกค้าอยู่');
    await this.prisma.$transaction(async (tx) => {
      await this.publishVersion(
        tx,
        actor,
        row,
        { ...row, audience: 'internal', customerIds: [] },
        actor.userId,
        `ถอนจากลูกค้า: ${reason.trim()}`,
      );
    });
    await this.record(
      actor,
      row.companyId,
      'kb.article.withdrawn_from_customers',
      id,
      {
        from: row.audience,
        customerIds: row.customerIds,
        reason: reason.trim(),
      },
    );
    return { id, version: row.version + 1 };
  }

  // --- merge ------------------------------------------------------------------

  /** Merges a duplicate into the main article (knowledge owners). */
  async merge(actor: Principal, id: string, intoId: string) {
    this.assertOwner(actor);
    if (id === intoId) throw invalid(['เลือกบทความหลักที่ไม่ใช่บทความนี้']);
    const source = await this.article(actor, id);
    const target = await this.article(actor, intoId);
    if (source.mergedIntoId)
      throw new AppError('CONFLICT', 'บทความนี้ถูกรวมไปแล้ว');
    if (target.status !== 'published' || target.mergedIntoId)
      throw new AppError('CONFLICT', 'บทความหลักต้องเผยแพร่อยู่');
    await this.prisma.$transaction(async (tx) => {
      await tx.kbArticle.update({
        where: { id },
        data: {
          status: 'archived',
          mergedIntoId: intoId,
          archivedAt: new Date(),
          archivedBy: actor.userId,
        },
      });
      await tx.kbArticleRevision.updateMany({
        where: { articleId: id, status: { in: [...OPEN_REVISION] } },
        data: { status: 'discarded' },
      });
      // Earlier merges into this one now point at the main article.
      await tx.kbArticle.updateMany({
        where: { mergedIntoId: id },
        data: { mergedIntoId: intoId },
      });
      const rated = await tx.kbArticleRating.findMany({
        where: { articleId: intoId },
        select: { userId: true },
      });
      await tx.kbArticleRating.updateMany({
        where: { articleId: id, userId: { notIn: rated.map((r) => r.userId) } },
        data: { articleId: intoId },
      });
      await tx.kbArticleRating.deleteMany({ where: { articleId: id } });
      const [yes, no] = await Promise.all([
        tx.kbArticleRating.count({
          where: { articleId: intoId, helpful: true },
        }),
        tx.kbArticleRating.count({
          where: { articleId: intoId, helpful: false },
        }),
      ]);
      await tx.kbArticle.update({
        where: { id: intoId },
        data: {
          tags: union(target.tags, source.tags),
          productCodes: union(target.productCodes, source.productCodes),
          productGroups: union(target.productGroups, source.productGroups),
          views: { increment: source.views },
          helpfulYes: yes,
          helpfulNo: no,
        },
      });
    });
    await this.record(actor, source.companyId, 'kb.article.merged', id, {
      into: intoId,
      intoNo: target.articleNo,
    });
    return { id, mergedIntoId: intoId };
  }

  // --- helpers ----------------------------------------------------------------

  /** Writes the content to the article as its next published version. */
  private async publishVersion(
    tx: Tx,
    actor: Principal,
    row: {
      id: string;
      version: number;
      categoryId: string | null;
      ownerId: string | null;
      authorId: string;
    },
    content: Content,
    writer: string,
    changeNote: string,
  ) {
    const version = row.version + 1;
    const next = addMonths(
      thaiToday(),
      await this.monthsFor(content.categoryId, tx),
    );
    await tx.kbArticleVersion.create({
      data: {
        articleId: row.id,
        version,
        title: content.title,
        summary: content.summary,
        body: content.body,
        categoryId: content.categoryId,
        tags: content.tags,
        productCodes: content.productCodes,
        productGroups: content.productGroups,
        audience: content.audience,
        customerIds: content.customerIds,
        changeNote: changeNote.slice(0, MAX_CHANGE_NOTE),
        writtenBy: writer,
        approvedBy: actor.userId,
      },
    });
    await tx.kbArticle.update({
      where: { id: row.id },
      data: {
        title: content.title,
        summary: content.summary,
        body: content.body,
        categoryId: content.categoryId,
        tags: content.tags,
        productCodes: content.productCodes,
        productGroups: content.productGroups,
        audience: content.audience,
        customerIds: content.customerIds,
        status: 'published',
        version,
        publishedAt: new Date(),
        publishedBy: actor.userId,
        archivedAt: null,
        archivedBy: null,
        reviewNote: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        ownerId: row.ownerId ?? row.authorId,
        lastReviewedAt: new Date(),
        lastReviewedBy: actor.userId,
        nextReviewOn: date(next),
        reviewRemindedOn: null,
        updatedBy: actor.userId,
      },
    });
  }

  private async monthsFor(categoryId: string | null, tx: Tx = this.prisma) {
    if (!categoryId) return reviewMonthsOf(null, null);
    const category = await tx.kbCategory.findUnique({
      where: { id: categoryId },
    });
    const parent = category?.parentId
      ? await tx.kbCategory.findUnique({ where: { id: category.parentId } })
      : null;
    return reviewMonthsOf(category, parent);
  }

  private async clean(companyId: string, input: SaveArticle): Promise<Content> {
    const audience = input.audience ?? 'internal';
    const content: Content = {
      audience,
      customerIds: audienceCustomers(audience, input.customerIds ?? []),
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      body: input.body ?? '',
      categoryId: input.categoryId || null,
      tags: normalizeTags(input.tags ?? []),
      productCodes: [
        ...new Set(
          (input.productCodes ?? []).map((c) => c.trim()).filter(Boolean),
        ),
      ],
      productGroups: [
        ...new Set(
          (input.productGroups ?? []).map((c) => c.trim()).filter(Boolean),
        ),
      ],
    };
    const problems = [
      ...articleProblems(content),
      ...audienceProblems(content.audience, content.customerIds),
    ];
    if (content.categoryId) {
      const found = await this.prisma.kbCategory.count({
        where: { id: content.categoryId, companyId },
      });
      if (!found) problems.push('ไม่พบหมวดที่เลือก');
    }
    if (content.customerIds.length) {
      const found = await this.prisma.customer.count({
        where: { companyId, id: { in: content.customerIds } },
      });
      if (found !== content.customerIds.length)
        problems.push('ไม่พบลูกค้าบางรายที่เลือก');
    }
    if (problems.length) throw invalid(problems);
    return content;
  }

  private async article(actor: Principal, id: string) {
    const row = await this.prisma.kbArticle.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    const visible =
      row.status === 'published' ||
      row.authorId === actor.userId ||
      row.ownerId === actor.userId ||
      hasPermission(actor, MANAGE);
    if (!visible) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    if (
      row.audience === 'selected' &&
      !hasPermission(actor, MANAGE) &&
      row.authorId !== actor.userId &&
      row.ownerId !== actor.userId
    ) {
      const seen = await this.kb.customersSeen(actor, row.customerIds);
      if (!row.customerIds.some((id) => seen.has(id)))
        throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    }
    return row;
  }

  private async revision(actor: Principal, id: string, revisionId: string) {
    await this.article(actor, id);
    const rev = await this.prisma.kbArticleRevision.findFirst({
      where: { id: revisionId, articleId: id },
    });
    if (!rev) throw new AppError('NOT_FOUND', 'ไม่พบฉบับปรับปรุงที่ระบุ');
    if (rev.createdBy !== actor.userId && !hasPermission(actor, MANAGE))
      throw new AppError('NOT_FOUND', 'ไม่พบฉบับปรับปรุงที่ระบุ');
    return rev;
  }

  openRevisionOf(articleId: string) {
    return this.prisma.kbArticleRevision.findFirst({
      where: { articleId, status: { in: [...OPEN_REVISION] } },
    });
  }

  private assertWriter(actor: Principal, writer: string) {
    if (writer !== actor.userId && !hasPermission(actor, MANAGE))
      throw new AppError(
        'FORBIDDEN',
        'ทำได้เฉพาะผู้เขียนหรือผู้ดูแลคลังความรู้',
      );
  }

  private assertOwner(actor: Principal) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ทำได้เฉพาะผู้ดูแลคลังความรู้');
  }

  private async owners(companyId: string) {
    const rows = await this.prisma.userRole.findMany({
      where: {
        companyId,
        role: {
          active: true,
          permissions: { some: { permissionCode: MANAGE } },
        },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async tellOwners(
    companyId: string,
    except: string,
    articleNo: string,
    title: string,
    id: string,
    what: 'requested',
  ) {
    for (const userId of await this.owners(companyId)) {
      if (userId === except) continue;
      await this.notifications.kbReview(
        userId,
        companyId,
        { id, articleNo, title },
        what,
        '',
      );
    }
  }

  private async people(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private record(
    actor: Principal,
    companyId: string,
    eventType: string,
    id: string,
    after: Prisma.InputJsonObject,
  ) {
    return this.audit.record({
      eventType,
      companyId,
      ...auditActor(actor),
      resourceType: 'kb_article',
      resourceId: id,
      after,
    });
  }
}

function addDays(from: string, days: number) {
  const at = new Date(`${from}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function invalid(problems: string[]) {
  return new AppError(
    'VALIDATION_FAILED',
    problems[0],
    problems.map((reason) => ({ field: 'article', reason })),
  );
}
