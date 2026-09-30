import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { ContractDraftsService } from './contract-drafts.service';
import {
  ContractRequestPackageService,
  present as presentPackage,
} from './contract-request-package.service';
import {
  checkItems,
  checkProblems,
  scopeItems,
  statusOf,
  type CheckedItem,
} from './contract-scope';
import { SaveScopeCheckDto } from './dto/legal-contract.dto';

/** CD-150 การตรวจขอบเขตงานรายฉบับ. */
@Injectable()
export class ContractScopeCheckRepository extends BaseRepository<
  PrismaService['contractScopeCheck']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractScopeCheck;
  }
}

interface CheckRow {
  id: string;
  versionNo: number;
  items: unknown;
  status: string;
  checkedBy: string;
  checkedAt: Date;
}

const savedVerdicts = (value: unknown) =>
  new Map(
    (Array.isArray(value) ? (value as CheckedItem[]) : [])
      .filter((item) => item.verdict)
      .map((item) => [
        item.key,
        { verdict: item.verdict!, note: item.note ?? null },
      ]),
  );

/**
 * CD-150 — ตรวจขอบเขตงาน. The scope of work the contract request brought
 * (CD-145: in scope, out of scope, deliverables and their acceptance
 * criteria) is compared with the draft's latest version: each item is
 * looked for in the text; one found matches, one not found needs Legal's
 * verdict — worded differently (with where), or not in line (with how).
 * The check belongs to the version it was made on; a later version must be
 * checked again. An inconsistent or unchecked latest version cannot be sent
 * for approval (CD-159). A request without an approved Solution has no
 * scope of work to check.
 */
@Injectable()
export class ContractScopeCheckService {
  constructor(
    private readonly checks: ContractScopeCheckRepository,
    private readonly drafts: ContractDraftsService,
    private readonly packages: ContractRequestPackageService,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
  ) {}

  async view(draftId: string, actor: Principal) {
    const subject = await this.drafts.subjectOf(draftId, actor);
    const row = await this.packages.of(subject.requestId);
    const pack = row ? presentPackage(row) : null;
    if (!pack?.solution) {
      return {
        applicable: false,
        editable: subject.editable,
        versionNo: subject.latestVersionNo,
        status: null,
        checked: null,
        lastCheckedVersionNo: null,
        items: [] as CheckedItem[],
      };
    }
    const clauses = await this.drafts.clausesOf(
      draftId,
      subject.latestVersionNo,
    );
    const rows = (await this.checks.findMany({
      where: { draftId },
      orderBy: { versionNo: 'desc' },
    })) as CheckRow[];
    const current = rows.find(
      (check) => check.versionNo === subject.latestVersionNo,
    );
    const items = checkItems(
      scopeItems(pack),
      clauses,
      savedVerdicts(current?.items),
    );
    const names = current
      ? await this.displayNames([current.checkedBy])
      : new Map<string, string>();
    return {
      applicable: true,
      editable: subject.editable,
      versionNo: subject.latestVersionNo,
      solution: pack.solution,
      status: current
        ? (current.status as 'consistent' | 'inconsistent')
        : null,
      checked: current
        ? {
            at: current.checkedAt,
            byName: names.get(current.checkedBy) ?? current.checkedBy,
          }
        : null,
      /** An earlier version was checked; this one is not yet. */
      lastCheckedVersionNo: rows[0]?.versionNo ?? null,
      items,
    };
  }

  /** Record the check of the latest version. */
  async save(draftId: string, dto: SaveScopeCheckDto, actor: Principal) {
    const subject = await this.drafts.subjectOf(draftId, actor);
    if (!subject.editable) {
      throw new AppError(
        'CONFLICT',
        'คำขอนี้ไม่ได้อยู่ระหว่างดำเนินการ — ตรวจขอบเขตงานไม่ได้',
      );
    }
    const row = await this.packages.of(subject.requestId);
    const pack = row ? presentPackage(row) : null;
    if (!pack?.solution) {
      throw new AppError(
        'CONFLICT',
        'คำขอนี้ไม่มีขอบเขตงานจาก Solution ที่อนุมัติ — ไม่มีอะไรให้ตรวจ',
      );
    }
    const clauses = await this.drafts.clausesOf(
      draftId,
      subject.latestVersionNo,
    );
    const given = new Map(
      dto.verdicts.map((verdict) => [
        verdict.key,
        { verdict: verdict.verdict, note: verdict.note?.trim() || null },
      ]),
    );
    const items = checkItems(scopeItems(pack), clauses, given);
    const problems = checkProblems(items);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'verdicts', reason })),
      );
    }
    const status = statusOf(items);
    await this.checks.upsert({
      where: {
        draftId_versionNo: { draftId, versionNo: subject.latestVersionNo },
      },
      create: {
        draftId,
        versionNo: subject.latestVersionNo,
        items: items as unknown as Prisma.InputJsonValue,
        status,
        checkedBy: actor.userId,
      },
      update: {
        items: items as unknown as Prisma.InputJsonValue,
        status,
        checkedBy: actor.userId,
        checkedAt: new Date(),
      },
    });
    await this.audit.record({
      eventType: 'legal.draft.scope_checked',
      companyId: subject.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: subject.requestId,
      after: {
        draftId,
        versionNo: subject.latestVersionNo,
        status,
        mismatched: items.filter((item) => item.verdict === 'mismatch').length,
      },
    });
    return this.view(draftId, actor);
  }

  /**
   * CD-159 — why the scope stops the approval, or null: not checked on the
   * latest version, or not in line.
   */
  async blocker(draftId: string, actor: Principal): Promise<string | null> {
    const view = await this.view(draftId, actor);
    if (!view.applicable) return null;
    if (!view.status) {
      return `ยังไม่ได้ตรวจขอบเขตงานของร่างฉบับที่ ${view.versionNo}`;
    }
    if (view.status === 'inconsistent') {
      return 'ขอบเขตงานในสัญญาไม่สอดคล้องกับขอบเขตงานที่แนบ — แก้ร่างแล้วตรวจใหม่';
    }
    return null;
  }

  private async displayNames(ids: string[]) {
    const users = (await this.members.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
