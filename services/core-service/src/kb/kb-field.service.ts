import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  Principal,
  PrismaService,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { DomainEventsService } from '../events/domain-events.service';
import {
  articleFromJobs,
  articleFromQa,
  articleFromProblem,
  problemReady,
  subjectTerms,
  PROBLEM_KNOWN,
} from './kb-field-rules';
import { likePattern } from './kb-rules';
import { KbReviewService } from './kb-review.service';
import { KbPresalesService } from './kb-presales.service';
import { KbService } from './kb.service';

const MANAGE = 'kb.article.manage';
const DEFAULT_INTERVAL_MS = 3_600_000;
const BACKFILL_DAYS = 30;

/**
 * CD-262 ความรู้จากงานบริการที่ปิดและปัญหาราก (part of CD-22 KBMS) — what the
 * field already wrote down flows into the knowledge base, without anyone
 * typing it again:
 *
 * - every closed service job (CD-239: its cause and fix are required) lands
 *   in the "ความรู้จากหน้างาน" inbox; the service team or a knowledge owner
 *   picks one or several (same product, same fix) into a draft, or skips —
 *   a job already fixed with an article (linked from the job) is not asked
 *   about again;
 * - a root-cause problem (CD-246) once known (a workaround or a permanent
 *   fix written) becomes one article, sent for review; when the problem
 *   changes, the published article gets a revision in review (a draft is
 *   rewritten in place);
 * - on a service job, articles for its equipment and subject are suggested,
 *   and the technician records the one that fixed it.
 */
@Injectable()
export class KbFieldService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbFieldService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kb: KbService,
    private readonly review: KbReviewService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    private readonly presales: KbPresalesService,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestCompleted, (event) => {
      const payload = event.payload as { request_id?: string };
      if (!payload.request_id) return Promise.resolve();
      return this.captureJob(payload.request_id)
        .then(() => undefined)
        .catch((error: Error) =>
          this.logger.warn(`field knowledge not captured: ${error.message}`),
        );
    });
    const interval =
      this.config.get<number>('kb.ingestIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-262 field knowledge', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- closed service jobs -------------------------------------------------------

  /** A closed job's case: into the inbox, once. Null when not a service job. */
  async captureJob(requestId: string) {
    const order = await this.prisma.serviceWorkOrder.findFirst({
      where: { requestId },
      select: {
        id: true,
        companyId: true,
        customerId: true,
        assetId: true,
        cause: true,
        resolution: true,
      },
    });
    if (!order?.cause?.trim() || !order.resolution?.trim()) return null;
    const [used, known] = await Promise.all([
      this.prisma.kbArticleUse.count({ where: { workOrderId: order.id } }),
      this.prisma.kbCandidate.count({
        where: { source: 'work_order', workOrderId: order.id },
      }),
    ]);
    if (used || known) return null;
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      select: {
        requestNo: true,
        formData: true,
        completedAt: true,
        closedAt: true,
      },
    });
    const form = (request?.formData ?? {}) as { subject?: string };
    const product = await this.productOf(order.companyId, order.assetId);
    try {
      return await this.prisma.kbCandidate.create({
        data: {
          companyId: order.companyId,
          sourceId: order.id,
          workOrderId: order.id,
          requestId,
          requestNo: request?.requestNo ?? null,
          title: form.subject?.trim() || 'งานบริการ',
          cause: order.cause.trim(),
          resolution: order.resolution.trim(),
          productCode: product.code,
          groupCode: product.group,
          customerId: order.customerId,
          closedAt: request?.completedAt ?? request?.closedAt ?? new Date(),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return null;
      throw error;
    }
  }

  /** The inbox: pending by default, grouped by product for picking together. */
  async inbox(actor: Principal, status = 'pending') {
    this.assertTriage(actor);
    // CD-264 — answered Pre-Sales questions, fresh each time the inbox opens
    if (status === 'pending')
      await this.presales.capture(actor.activeCompanyId);
    const rows = await this.prisma.kbCandidate.findMany({
      where: { companyId: actor.activeCompanyId, status },
      orderBy: { closedAt: 'desc' },
      take: 300,
    });
    const codes = [
      ...new Set(
        rows.flatMap((r) => [r.productCode, r.groupCode]).filter(Boolean),
      ),
    ] as string[];
    const [products, customers, articles] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          companyId: actor.activeCompanyId,
          OR: [{ code: { in: codes } }, { groupCode: { in: codes } }],
        },
        select: { code: true, name: true, groupCode: true, groupName: true },
      }),
      this.prisma.customer.findMany({
        where: {
          id: {
            in: rows
              .map((r) => r.customerId)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true, nameTh: true },
      }),
      this.prisma.kbArticle.findMany({
        where: {
          id: {
            in: rows.map((r) => r.articleId).filter((id): id is string => !!id),
          },
        },
        select: { id: true, articleNo: true, title: true },
      }),
    ]);
    const label = (r: (typeof rows)[number]) => {
      if (r.productCode) {
        const p = products.find((x) => x.code === r.productCode);
        return p ? `${p.code} · ${p.name}` : r.productCode;
      }
      if (r.groupCode) {
        const g = products.find((x) => x.groupCode === r.groupCode);
        return g?.groupName ? `${r.groupCode} · ${g.groupName}` : r.groupCode;
      }
      return null;
    };
    return {
      canManage: hasPermission(actor, MANAGE),
      items: rows.map((r) => ({
        id: r.id,
        source: r.source,
        solutionId: r.solutionId,
        workOrderId: r.workOrderId,
        requestId: r.requestId,
        requestNo: r.requestNo,
        title: r.title,
        cause: r.cause,
        resolution: r.resolution,
        product: label(r),
        groupKey: r.productCode ?? r.groupCode ?? '',
        customer: customers.find((c) => c.id === r.customerId)?.nameTh ?? null,
        closedAt: r.closedAt,
        status: r.status,
        article: articles.find((a) => a.id === r.articleId) ?? null,
        skipReason: r.skipReason,
      })),
    };
  }

  /** One or several jobs into a draft (the picker writes it; internal). */
  async draftFrom(actor: Principal, ids: string[], title?: string) {
    this.assertTriage(actor);
    const rows = await this.prisma.kbCandidate.findMany({
      where: {
        id: { in: ids },
        companyId: actor.activeCompanyId,
        status: 'pending',
      },
      orderBy: { closedAt: 'asc' },
    });
    if (!rows.length || rows.length !== new Set(ids).size)
      throw new AppError(
        'CONFLICT',
        'บางรายการถูกคัดไปแล้ว — โหลดใหม่อีกครั้ง',
      );
    const sources = new Set(rows.map((r) => r.source));
    if (sources.size > 1)
      throw new AppError(
        'VALIDATION_FAILED',
        'รวมใบงานบริการกับคำถาม Pre-Sales ในบทความเดียวไม่ได้ — เลือกทีละแหล่ง',
        [{ field: 'ids', reason: 'mixed_sources' }],
      );
    const presales = sources.has('presales');
    const draft = presales
      ? {
          ...articleFromQa(
            rows.map((r) => ({ question: r.title, answer: r.resolution })),
          ),
          // no customer or deal in the article; the inbox keeps where it came from
          sourceRef: null,
        }
      : articleFromJobs(rows.map((r) => ({ ...r, requestNo: r.requestNo })));
    const article = await this.kb.insertDraft(
      actor.activeCompanyId,
      actor.userId,
      {
        title: title?.trim() || draft.title,
        body: draft.body,
        productCodes: [
          ...new Set(
            rows.map((r) => r.productCode).filter((c): c is string => !!c),
          ),
        ],
        productGroups: [
          ...new Set(
            rows
              .filter((r) => !r.productCode)
              .map((r) => r.groupCode)
              .filter((c): c is string => !!c),
          ),
        ],
      },
      { source: presales ? 'presales' : 'service', sourceRef: draft.sourceRef },
    );
    await this.prisma.kbCandidate.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        status: 'drafted',
        articleId: article.id,
        decidedBy: actor.userId,
        decidedAt: new Date(),
      },
    });
    await this.record(actor, 'kb.field.drafted', article.id, {
      jobs: rows.map((r) => r.requestNo ?? r.workOrderId),
    });
    return { articleId: article.id, articleNo: article.articleNo };
  }

  async skip(actor: Principal, ids: string[], reason: string) {
    this.assertTriage(actor);
    if (!reason.trim())
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ข้าม', [
        { field: 'reason', reason: 'ต้องระบุเหตุผลที่ข้าม' },
      ]);
    const done = await this.prisma.kbCandidate.updateMany({
      where: {
        id: { in: ids },
        companyId: actor.activeCompanyId,
        status: 'pending',
      },
      data: {
        status: 'skipped',
        skipReason: reason.trim(),
        decidedBy: actor.userId,
        decidedAt: new Date(),
      },
    });
    return { skipped: done.count };
  }

  // --- suggestions on a job ------------------------------------------------------

  /** Articles for a job's equipment and subject, and those used on it. */
  async suggest(actor: Principal, workOrderId: string) {
    const order = await this.order(actor, workOrderId);
    const request = await this.prisma.request.findUnique({
      where: { id: order.requestId },
      select: { formData: true },
    });
    const subject =
      ((request?.formData ?? {}) as { subject?: string }).subject ?? '';
    const product = await this.productOf(order.companyId, order.assetId);
    const terms = subjectTerms(subject);
    const params: unknown[] = [
      order.companyId,
      product.code ? [product.code] : [],
      product.group ? [product.group] : [],
    ];
    const termScores = terms.map((t) => {
      params.push(likePattern(t));
      const p = `$${params.length}`;
      return `(CASE WHEN a.title ILIKE ${p} OR array_to_string(a.tags, ' ') ILIKE ${p} THEN 2
                    WHEN a.body ILIKE ${p} THEN 1 ELSE 0 END)`;
    });
    const productScore = `(CASE WHEN a."productCodes" && $2::text[] THEN 6
                                WHEN a."productGroups" && $3::text[] THEN 4 ELSE 0 END)`;
    const score = [productScore, ...termScores].join(' + ');
    const rows = await this.prisma.$queryRawUnsafe<
      {
        id: string;
        articleNo: string;
        title: string;
        summary: string | null;
        audience: string;
        customerIds: string[];
        authorId: string;
        ownerId: string | null;
        score: number;
      }[]
    >(
      `SELECT a.id, a."articleNo", a.title, a.summary, a.audience, a."customerIds",
              a."authorId", a."ownerId", (${score})::float AS score
       FROM kb_articles a
       WHERE a."companyId" = $1 AND a.status = 'published' AND (${score}) > 0
       ORDER BY score DESC, a."helpfulYes" DESC
       LIMIT 15`,
      ...params,
    );
    // A selected-customers article: for this job's customer, or one the reader sees.
    const seen = await this.kb.customersSeen(
      actor,
      rows.flatMap((r) => (r.audience === 'selected' ? r.customerIds : [])),
    );
    const visible = rows
      .filter(
        (r) =>
          r.audience !== 'selected' ||
          (order.customerId && r.customerIds.includes(order.customerId)) ||
          r.customerIds.some((id) => seen.has(id)),
      )
      .slice(0, 5);
    const uses = await this.prisma.kbArticleUse.findMany({
      where: { workOrderId },
      orderBy: { usedAt: 'asc' },
    });
    const used = await this.prisma.kbArticle.findMany({
      where: { id: { in: uses.map((u) => u.articleId) } },
      select: { id: true, articleNo: true, title: true },
    });
    return {
      terms,
      product: product.code ?? product.group,
      suggestions: visible.map((r) => ({
        id: r.id,
        articleNo: r.articleNo,
        title: r.title,
        summary: r.summary,
        used: uses.some((u) => u.articleId === r.id),
      })),
      used: used.map((a) => ({
        id: a.id,
        articleNo: a.articleNo,
        title: a.title,
      })),
    };
  }

  /** The technician records the article that fixed the job (or takes it back). */
  async markUsed(
    actor: Principal,
    workOrderId: string,
    articleId: string,
    used: boolean,
  ) {
    const order = await this.order(actor, workOrderId);
    const article = await this.prisma.kbArticle.findFirst({
      where: { id: articleId, companyId: order.companyId, status: 'published' },
      select: { id: true },
    });
    if (!article) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    if (used) {
      await this.prisma.kbArticleUse.upsert({
        where: { articleId_workOrderId: { articleId, workOrderId } },
        create: { articleId, workOrderId, usedBy: actor.userId },
        update: {},
      });
      // Fixed with an article already: nothing new for the inbox.
      await this.prisma.kbCandidate.updateMany({
        where: { workOrderId, status: 'pending' },
        data: {
          status: 'skipped',
          skipReason: 'แก้ด้วยบทความที่มีอยู่แล้ว',
          articleId,
          decidedBy: actor.userId,
          decidedAt: new Date(),
        },
      });
    } else {
      await this.prisma.kbArticleUse.deleteMany({
        where: { articleId, workOrderId },
      });
    }
    return this.suggest(actor, workOrderId);
  }

  /** Where an article came from, and how often it fixed a job. */
  async provenance(articleId: string) {
    const [uses, jobs, problem] = await Promise.all([
      this.prisma.kbArticleUse.count({ where: { articleId } }),
      this.prisma.kbCandidate.findMany({
        where: { articleId, status: 'drafted' },
        select: {
          source: true,
          requestId: true,
          requestNo: true,
          solutionId: true,
        },
      }),
      this.prisma.kbProblemLink.findFirst({ where: { articleId } }),
    ]);
    const problemRow = problem
      ? await this.prisma.serviceProblem.findUnique({
          where: { id: problem.problemId },
          select: { id: true, problemNo: true, title: true, status: true },
        })
      : null;
    return {
      usedOnJobs: uses,
      fromJobs: jobs.filter((j) => j.source === 'work_order'),
      // CD-264 — the Solutions it came from (staff only; never in the article)
      fromSolutions: [
        ...new Map(
          jobs
            .filter((j) => j.source === 'presales' && j.solutionId)
            .map((j) => [
              j.solutionId!,
              { solutionId: j.solutionId!, title: j.requestNo },
            ]),
        ).values(),
      ],
      fromProblem: problemRow,
    };
  }

  // --- root-cause problems and catch-up ------------------------------------------

  async sweep(now: Date = new Date()) {
    // CD-264 — answered Pre-Sales questions, every company
    let captured = await this.presales.capture();
    // Jobs closed while the listener was down.
    const since = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
    const missed = await this.prisma.$queryRawUnsafe<{ request_id: string }[]>(
      `SELECT w."requestId" AS request_id
       FROM service_work_orders w
       JOIN requests r ON r.id = w."requestId"
       WHERE r.status IN ('completed', 'closed')
         AND COALESCE(r."completedAt", r."closedAt") >= $1
         AND w.resolution IS NOT NULL AND w.cause IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM kb_candidates c WHERE c."workOrderId" = w.id)
         AND NOT EXISTS (SELECT 1 FROM kb_article_uses u WHERE u."workOrderId" = w.id)
       LIMIT 500`,
      since,
    );
    for (const row of missed)
      if (await this.captureJob(row.request_id)) captured += 1;

    let problems = 0;
    const rows = await this.prisma.serviceProblem.findMany({
      where: { status: { in: [...PROBLEM_KNOWN] } },
    });
    for (const p of rows) {
      try {
        if (await this.syncProblem(p)) problems += 1;
      } catch (error) {
        this.logger.warn(
          `problem ${p.problemNo} not synced: ${(error as Error).message}`,
        );
      }
    }
    return { captured, problems };
  }

  /** One known error ↔ one article: written once, then kept in step. */
  async syncProblem(p: {
    id: string;
    companyId: string;
    problemNo: string;
    title: string;
    status: string;
    rootCause: string | null;
    workaround: string | null;
    permanentFix: string | null;
    productCode: string | null;
    ownerUserId: string;
    updatedAt: Date;
  }) {
    if (!problemReady(p)) return false;
    const content = articleFromProblem(p);
    const link = await this.prisma.kbProblemLink.findUnique({
      where: { problemId: p.id },
    });
    if (!link) {
      const article = await this.kb.insertDraft(
        p.companyId,
        p.ownerUserId,
        {
          title: content.title,
          body: content.body,
          productCodes: p.productCode ? [p.productCode] : [],
        },
        { source: 'problem', sourceRef: content.sourceRef },
      );
      await this.prisma.kbProblemLink.create({
        data: { problemId: p.id, articleId: article.id, syncedAt: p.updatedAt },
      });
      await this.review.submitSystemDraft(article.id);
      return true;
    }
    if (p.updatedAt <= link.syncedAt) return false;
    const article = await this.prisma.kbArticle.findUnique({
      where: { id: link.articleId },
    });
    if (!article || article.mergedIntoId) {
      await this.touch(p.id, p.updatedAt);
      return false;
    }
    if (article.status === 'draft' || article.status === 'in_review') {
      await this.prisma.kbArticle.update({
        where: { id: article.id },
        data: { title: content.title, body: content.body },
      });
    } else if (article.status === 'published') {
      const revision = await this.review.systemRevision(
        article.id,
        content,
        p.ownerUserId,
        `อัปเดตจากปัญหา ${p.problemNo}`,
      );
      if (!revision) return false; // a revision is open — try again next sweep
    }
    await this.touch(p.id, p.updatedAt);
    return true;
  }

  // --- helpers ----------------------------------------------------------------

  private touch(problemId: string, at: Date) {
    return this.prisma.kbProblemLink.update({
      where: { problemId },
      data: { syncedAt: at },
    });
  }

  private async productOf(companyId: string, assetId: string | null) {
    if (!assetId) return { code: null, group: null };
    const asset = await this.prisma.serviceAsset.findUnique({
      where: { id: assetId },
      select: { productCode: true },
    });
    if (!asset?.productCode) return { code: null, group: null };
    const product = await this.prisma.product.findFirst({
      where: { companyId, code: asset.productCode },
      select: { groupCode: true },
    });
    return { code: asset.productCode, group: product?.groupCode ?? null };
  }

  private async order(actor: Principal, workOrderId: string) {
    const order = await this.prisma.serviceWorkOrder.findFirst({
      where: { id: workOrderId, companyId: actor.activeCompanyId },
      select: {
        id: true,
        companyId: true,
        requestId: true,
        assetId: true,
        customerId: true,
      },
    });
    if (!order) throw new AppError('NOT_FOUND', 'ไม่พบใบงานที่ระบุ');
    return order;
  }

  private assertTriage(actor: Principal) {
    if (
      !hasPermission(actor, MANAGE) &&
      !hasPermission(actor, 'service.asset.manage') &&
      !hasPermission(actor, 'presales.solution.manage')
    )
      throw new AppError(
        'FORBIDDEN',
        'คัดความรู้ได้เฉพาะทีมบริการ Pre-Sales หรือผู้ดูแลคลังความรู้',
      );
  }

  private record(
    actor: Principal,
    eventType: string,
    id: string,
    after: Prisma.InputJsonObject,
  ) {
    return this.audit.record({
      eventType,
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'kb_article',
      resourceId: id,
      after,
    });
  }
}
