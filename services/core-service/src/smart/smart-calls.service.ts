import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { DoNotContactService } from '../contact-preferences/do-not-contact.service';
import { CompanyRepository } from '../crm/product.repositories';
import { KbArticleRepository } from '../kb/kb.repositories';
import { WorkCalendarRepository } from '../pm/project.repositories';
import {
  type CallWindow,
  checkBeforeCall,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MIN_GAP_DAYS,
  DEFAULT_OPENING,
  DEFAULT_OPT_OUT,
  DEFAULT_WINDOWS,
  HOLD_LABELS,
  type HoldReason,
  inWindow,
  openingFor,
  windowsProblem,
} from './call-rules';
import { SaveCallListDto, SaveCallPolicyDto } from './smart-calls.dto';
import {
  SmartCallListRepository,
  SmartCallPolicyRepository,
  SmartCallTargetRepository,
  SmartProspectRepository,
} from './smart.repositories';

interface PolicyRow {
  id: string;
  companyId: string;
  windows: unknown;
  maxAttempts: number;
  minGapDays: number;
  openingScript: string;
  optOutScript: string;
  certifiedBy: string | null;
  certifiedAt: Date | null;
  certifiedNote: string | null;
  updatedAt: Date;
}

interface ListRow {
  id: string;
  companyId: string;
  name: string;
  script: string;
  kbArticleIds: string[];
  status: string;
  createdAt: Date;
}

interface TargetRow {
  id: string;
  companyId: string;
  listId: string;
  prospectId: string;
  name: string;
  phone: string;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  lastOutcome: string | null;
  blockReason: string | null;
}

/** The policy a company has before anyone saves one — never certified. */
const DEFAULT_POLICY = {
  windows: DEFAULT_WINDOWS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  minGapDays: DEFAULT_MIN_GAP_DAYS,
  openingScript: DEFAULT_OPENING,
  optOutScript: DEFAULT_OPT_OUT,
  certifiedBy: null,
  certifiedAt: null,
  certifiedNote: null,
};

/**
 * CD-291 (CD-16 AI SMART) — call lists and the checks every call passes.
 *
 * Nothing is dialled here; CD-292's connector asks `callable` which targets
 * may be called right now and reports back through `recordAttempt`. What this
 * owns is the rule: a company's calling policy certified by legal, the
 * opening that names who is calling and how to refuse, the do-not-contact
 * register, the calling hours, and how often one number may be tried.
 */
@Injectable()
export class SmartCallsService {
  constructor(
    private readonly policies: SmartCallPolicyRepository,
    private readonly lists: SmartCallListRepository,
    private readonly targets: SmartCallTargetRepository,
    private readonly prospects: SmartProspectRepository,
    private readonly optOuts: DoNotContactService,
    private readonly articles: KbArticleRepository,
    private readonly companies: CompanyRepository,
    private readonly calendars: WorkCalendarRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  // --- policy ------------------------------------------------------------------

  async policy(actor: Principal) {
    const [row, company] = await Promise.all([
      this.policyRow(actor.activeCompanyId),
      this.companyName(actor.activeCompanyId),
    ]);
    const policy = row ?? DEFAULT_POLICY;
    return {
      windows: policy.windows as CallWindow[],
      max_attempts: policy.maxAttempts,
      min_gap_days: policy.minGapDays,
      opening_script: policy.openingScript,
      optout_script: policy.optOutScript,
      opening_preview: openingFor(policy, company),
      saved: row !== null,
      certified: !!policy.certifiedAt,
      certified_by: policy.certifiedBy,
      certified_at: policy.certifiedAt,
      certified_note: policy.certifiedNote,
    };
  }

  /** Saving any change clears the certification — legal certifies what is in force. */
  async savePolicy(actor: Principal, dto: SaveCallPolicyDto) {
    const problem = windowsProblem(dto.windows);
    if (problem) throw new AppError('VALIDATION_FAILED', problem);
    const companyId = actor.activeCompanyId;
    const before = await this.policyRow(companyId);
    const data = {
      windows: dto.windows as never,
      maxAttempts: dto.max_attempts,
      minGapDays: dto.min_gap_days,
      openingScript: dto.opening_script.trim(),
      optOutScript: dto.optout_script.trim(),
      certifiedBy: null,
      certifiedAt: null,
      certifiedNote: null,
      updatedBy: actor.userId,
    };
    await this.transactions.execute(async (prisma) => {
      await this.policies.upsert(
        { where: { companyId }, create: { companyId, ...data }, update: data },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'smart.call_policy.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'smart_call_policy',
          resourceId: companyId,
          before: before
            ? {
                windows: before.windows as never,
                maxAttempts: before.maxAttempts,
                minGapDays: before.minGapDays,
                certifiedAt: before.certifiedAt?.toISOString() ?? null,
              }
            : undefined,
          after: {
            windows: dto.windows as never,
            maxAttempts: dto.max_attempts,
            minGapDays: dto.min_gap_days,
            certifiedAt: null,
          },
        },
        { prisma },
      );
    });
    return this.policy(actor);
  }

  /** Legal certifies the policy in force (route: legal.contract.manage). */
  async certify(actor: Principal, note: string | undefined) {
    const companyId = actor.activeCompanyId;
    const row = await this.policyRow(companyId);
    if (!row) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้บันทึกนโยบายการโทร — บันทึกนโยบายก่อนแล้วจึงรับรอง',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.policies.update(
        {
          where: { companyId },
          data: {
            certifiedBy: actor.userId,
            certifiedAt: new Date(),
            certifiedNote: note?.trim() || null,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'smart.call_policy.certified',
          companyId,
          ...auditActor(actor),
          resourceType: 'smart_call_policy',
          resourceId: companyId,
          after: {
            note: note ?? null,
            policyUpdatedAt: row.updatedAt.toISOString(),
          },
        },
        { prisma },
      );
    });
    return this.policy(actor);
  }

  // --- lists -------------------------------------------------------------------

  async listLists(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [rows, counts] = await Promise.all([
      this.lists.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      }) as Promise<ListRow[]>,
      this.targets.countsByList(companyId),
    ]);
    return rows.map((row) => ({
      ...this.listView(row),
      targets: Object.fromEntries(
        counts
          .filter((count) => count.listId === row.id)
          .map((count) => [count.status, count.count]),
      ),
    }));
  }

  async createList(actor: Principal, dto: SaveCallListDto) {
    await this.assertArticles(actor.activeCompanyId, dto.kb_article_ids ?? []);
    const row = await this.transactions.execute(async (prisma) => {
      const created = (await this.lists.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            name: dto.name.trim(),
            script: dto.script.trim(),
            kbArticleIds: dto.kb_article_ids ?? [],
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as ListRow;
      await this.audit.record(
        {
          eventType: 'smart.call_list.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'smart_call_list',
          resourceId: created.id,
          after: { name: created.name },
        },
        { prisma },
      );
      return created;
    });
    return this.listView(row);
  }

  async updateList(actor: Principal, id: string, dto: SaveCallListDto) {
    const list = await this.list(actor, id);
    if (list.status === 'closed') {
      throw new AppError('CONFLICT', 'รายการโทรนี้ปิดแล้ว — แก้ไม่ได้');
    }
    await this.assertArticles(actor.activeCompanyId, dto.kb_article_ids ?? []);
    const row = (await this.lists.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        script: dto.script.trim(),
        kbArticleIds: dto.kb_article_ids ?? [],
      },
    })) as ListRow;
    return this.listView(row);
  }

  /** active needs a certified policy; closed is final. */
  async setStatus(
    actor: Principal,
    id: string,
    status: 'active' | 'paused' | 'closed',
  ) {
    const list = await this.list(actor, id);
    if (list.status === 'closed') {
      throw new AppError('CONFLICT', 'รายการโทรนี้ปิดแล้ว');
    }
    if (status === 'active') {
      const policy = await this.policyRow(actor.activeCompanyId);
      if (!policy?.certifiedAt) {
        throw new AppError(
          'CONFLICT',
          'นโยบายการโทรยังไม่ได้รับรองจากฝ่ายกฎหมาย — เปิดใช้รายการโทรไม่ได้',
        );
      }
    }
    const row = await this.transactions.execute(async (prisma) => {
      const next = (await this.lists.update(
        { where: { id }, data: { status } },
        { prisma },
      )) as ListRow;
      await this.audit.record(
        {
          eventType: 'smart.call_list.status',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'smart_call_list',
          resourceId: id,
          before: { status: list.status },
          after: { status },
        },
        { prisma },
      );
      return next;
    });
    return this.listView(row);
  }

  /** Screened (or sent) businesses onto a list; one without a phone is skipped. */
  async addTargets(actor: Principal, listId: string, prospectIds: string[]) {
    const companyId = actor.activeCompanyId;
    const list = await this.list(actor, listId);
    if (list.status === 'closed') {
      throw new AppError('CONFLICT', 'รายการโทรนี้ปิดแล้ว');
    }
    const rows = (await this.prospects.findMany({
      where: { companyId, id: { in: prospectIds } },
      select: { id: true, name: true, phone: true, status: true },
    })) as { id: string; name: string; phone: string | null; status: string }[];
    const skipped: { id: string; name: string; reason: string }[] = [];
    const usable = rows.filter((row) => {
      if (row.status === 'discarded' || row.status === 'new') {
        skipped.push({
          id: row.id,
          name: row.name,
          reason: row.status === 'new' ? 'ยังไม่ได้คัดกรอง' : 'ถูกทิ้งไปแล้ว',
        });
        return false;
      }
      if (!row.phone) {
        skipped.push({
          id: row.id,
          name: row.name,
          reason: HOLD_LABELS.no_phone,
        });
        return false;
      }
      return true;
    });
    const blocked = await this.optOuts.blockedPhones(
      companyId,
      usable.map((row) => row.phone as string),
    );
    const { count } = await this.targets.createMany({
      data: usable.map((row) => ({
        companyId,
        listId,
        prospectId: row.id,
        name: row.name,
        phone: row.phone as string,
        ...(blocked.has(row.phone as string)
          ? { status: 'blocked', blockReason: 'do_not_contact' }
          : {}),
      })),
      skipDuplicates: true,
    });
    return {
      added: count,
      already: usable.length - count,
      blocked: usable.filter((row) => blocked.has(row.phone as string)).length,
      skipped,
    };
  }

  /** The list's targets, each with why it would be held back now (if it would). */
  async listTargets(actor: Principal, listId: string, now = new Date()) {
    const list = await this.list(actor, listId);
    const rows = (await this.targets.findMany({
      where: { companyId: actor.activeCompanyId, listId },
      orderBy: { createdAt: 'asc' },
    })) as TargetRow[];
    const judged = await this.judge(actor.activeCompanyId, list, rows, now);
    return rows.map((row) => {
      const hold = judged.get(row.id) ?? null;
      return {
        id: row.id,
        prospect_id: row.prospectId,
        name: row.name,
        phone: row.phone,
        status: row.status,
        attempts: row.attempts,
        last_attempt_at: row.lastAttemptAt,
        last_outcome: row.lastOutcome,
        hold,
        hold_label: hold ? HOLD_LABELS[hold] : null,
      };
    });
  }

  /** What the AI says on this list: the opening, the script, the articles. */
  async script(actor: Principal, listId: string) {
    const list = await this.list(actor, listId);
    const [policy, company, articles] = await Promise.all([
      this.policyRow(actor.activeCompanyId),
      this.companyName(actor.activeCompanyId),
      list.kbArticleIds.length
        ? (this.articles.findMany({
            where: {
              companyId: actor.activeCompanyId,
              id: { in: list.kbArticleIds },
            },
            select: {
              id: true,
              articleNo: true,
              title: true,
              summary: true,
              status: true,
            },
          }) as Promise<
            {
              id: string;
              articleNo: string;
              title: string;
              summary: string | null;
              status: string;
            }[]
          >)
        : Promise.resolve([]),
    ]);
    return {
      opening: openingFor(policy ?? DEFAULT_POLICY, company),
      script: list.script,
      articles: articles.map((article) => ({
        id: article.id,
        article_no: article.articleNo,
        title: article.title,
        summary: article.summary,
        published: article.status === 'published',
      })),
    };
  }

  /** CD-292 — the targets that may be dialled right now. */
  async callable(companyId: string, listId: string, now = new Date()) {
    const list = (await this.lists.findFirst({
      where: { id: listId, companyId },
    })) as ListRow | null;
    if (!list) return [];
    const rows = (await this.targets.findMany({
      where: { companyId, listId, status: 'pending' },
      orderBy: [{ attempts: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    })) as TargetRow[];
    const judged = await this.judge(companyId, list, rows, now);
    return rows.filter((row) => judged.get(row.id) === null);
  }

  /**
   * "Don't call me again" — heard on a call (`actor` null, CD-292) or told to
   * staff. The number joins the register at once and the target stops.
   */
  async refuse(
    companyId: string,
    targetId: string,
    actor: Principal | null,
    reason?: string,
  ) {
    const target = (await this.targets.findFirst({
      where: { id: targetId, companyId },
    })) as TargetRow | null;
    if (!target) throw new AppError('NOT_FOUND', 'ไม่พบรายการในรายการโทร');
    await this.optOuts.add(
      companyId,
      {
        kind: 'phone',
        value: target.phone,
        channel: 'call',
        reason: reason ?? 'ปฏิเสธการติดต่อระหว่างสาย',
        source: 'call_refusal',
        sourceRef: `smart_call_target:${target.id}`,
      },
      actor,
    );
    // Every list holding this number stops calling it, not only this one.
    await this.targets.updateMany({
      where: { companyId, phone: target.phone, status: 'pending' },
      data: { status: 'blocked', blockReason: 'do_not_contact' },
    });
    return { blocked: true };
  }

  // --- helpers -----------------------------------------------------------------

  /** Hold reason (or null = may call) for each target, against the live register. */
  private async judge(
    companyId: string,
    list: ListRow,
    rows: TargetRow[],
    now: Date,
  ): Promise<Map<string, HoldReason | null>> {
    const [policy, holidays, blocked] = await Promise.all([
      this.policyRow(companyId),
      this.holidays(companyId),
      this.optOuts.blockedPhones(
        companyId,
        rows.map((row) => row.phone),
      ),
    ]);
    const settings = policy ?? DEFAULT_POLICY;
    const open = inWindow(settings.windows as CallWindow[], holidays, now);
    return new Map(
      rows.map((row) => [
        row.id,
        checkBeforeCall({
          policyCertified: !!policy?.certifiedAt,
          listStatus: list.status,
          targetStatus: row.status,
          phone: row.phone,
          blocked: blocked.has(row.phone),
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt,
          maxAttempts: settings.maxAttempts,
          minGapDays: settings.minGapDays,
          inWindow: open,
          now,
        }),
      ]),
    );
  }

  private async assertArticles(companyId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = (await this.articles.findMany({
      where: { companyId, id: { in: ids }, status: 'published' },
      select: { id: true },
    })) as { id: string }[];
    if (rows.length !== new Set(ids).size) {
      throw new AppError(
        'VALIDATION_FAILED',
        'บทพูดอ้างได้เฉพาะบทความ KBMS ที่อนุมัติและเผยแพร่แล้ว',
        [{ field: 'kb_article_ids', reason: 'not published' }],
      );
    }
  }

  private async list(actor: Principal, id: string) {
    const row = (await this.lists.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ListRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการโทร');
    return row;
  }

  private policyRow(companyId: string) {
    return this.policies.findFirst({
      where: { companyId },
    }) as Promise<PolicyRow | null>;
  }

  private async holidays(companyId: string): Promise<string[]> {
    const row = (await this.calendars.findFirst({
      where: { companyId },
      select: { holidays: true },
    })) as { holidays: unknown } | null;
    return Array.isArray(row?.holidays)
      ? row.holidays.filter((day): day is string => typeof day === 'string')
      : [];
  }

  private async companyName(companyId: string) {
    const row = (await this.companies.findFirst({
      where: { id: companyId },
      select: { name: true },
    })) as { name: string } | null;
    return row?.name ?? '';
  }

  private listView(row: ListRow) {
    return {
      id: row.id,
      name: row.name,
      script: row.script,
      kb_article_ids: row.kbArticleIds,
      status: row.status,
      created_at: row.createdAt,
    };
  }
}
