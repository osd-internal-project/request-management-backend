import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  PrismaTransactionService,
  type TQueryClient,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { ContractDraftsService } from './contract-drafts.service';
import {
  answerProblem,
  clauseChanged,
  compareVersions,
} from './contract-review';
import {
  AnswerReviewCommentDto,
  OpenReviewRoundDto,
  ReviewCommentDto,
} from './dto/legal-contract.dto';

/** CD-147 รอบตรวจสัญญา. */
@Injectable()
export class ContractReviewRoundRepository extends BaseRepository<
  PrismaService['contractReviewRound']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractReviewRound;
  }
}

/** CD-147 ความเห็นรายข้อ. */
@Injectable()
export class ContractReviewCommentRepository extends BaseRepository<
  PrismaService['contractReviewComment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractReviewComment;
  }
}

interface RoundRow {
  id: string;
  companyId: string;
  draftId: string;
  roundNo: number;
  versionNo: number;
  note: string | null;
  status: string;
  openedBy: string;
  openedAt: Date;
  closedBy: string | null;
  closedAt: Date | null;
  closedVersionNo: number | null;
}

interface CommentRow {
  id: string;
  roundId: string;
  clauseKey: string;
  clauseHeading: string;
  body: string;
  createdBy: string;
  createdAt: Date;
  status: string;
  response: string | null;
  respondedBy: string | null;
  respondedAt: Date | null;
  resolvedInVersion: number | null;
}

/**
 * CD-147 — ตรวจสัญญา. A review round is opened on the draft's latest
 * version; reviewers comment clause by clause; the drafter answers each
 * comment — fixed (the version it was fixed in is kept) or not fixed, with
 * the reason — and the round closes only once every comment is answered.
 * Each comment says whether its clause has changed since the version under
 * review, so the drafter sees what has been dealt with. Any two versions can
 * be compared clause by clause.
 *
 * One round open at a time. Read with `legal.contract.read`; opening,
 * commenting, answering and closing with `legal.contract.manage`, and only
 * while the contract request is open.
 */
@Injectable()
export class ContractReviewsService {
  constructor(
    private readonly rounds: ContractReviewRoundRepository,
    private readonly comments: ContractReviewCommentRepository,
    private readonly drafts: ContractDraftsService,
    private readonly members: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async list(draftId: string, actor: Principal) {
    const { draft } = await this.drafts.access(draftId, actor);
    const rounds = (await this.rounds.findMany({
      where: { draftId },
      orderBy: { roundNo: 'desc' },
    })) as RoundRow[];
    const comments = (await this.comments.findMany({
      where: { roundId: { in: rounds.map((round) => round.id) } },
      orderBy: { createdAt: 'asc' },
    })) as CommentRow[];
    const latest = await this.drafts.clausesOf(draftId, draft.latestVersionNo);
    const reviewed = new Map<
      number,
      Awaited<ReturnType<typeof this.drafts.clausesOf>>
    >();
    for (const round of rounds) {
      if (!reviewed.has(round.versionNo)) {
        reviewed.set(
          round.versionNo,
          await this.drafts.clausesOf(draftId, round.versionNo),
        );
      }
    }
    const names = await this.displayNames([
      ...rounds.flatMap((round) => [round.openedBy, round.closedBy]),
      ...comments.flatMap((comment) => [
        comment.createdBy,
        comment.respondedBy,
      ]),
    ]);
    const name = (id: string | null) => (id ? (names.get(id) ?? id) : null);
    return {
      latestVersionNo: draft.latestVersionNo,
      rounds: rounds.map((round) => {
        const own = comments.filter((comment) => comment.roundId === round.id);
        return {
          ...round,
          openedByName: name(round.openedBy),
          closedByName: name(round.closedBy),
          openCount: own.filter((comment) => comment.status === 'open').length,
          comments: own.map((comment) => ({
            ...comment,
            createdByName: name(comment.createdBy),
            respondedByName: name(comment.respondedBy),
            changedSince: clauseChanged(
              comment.clauseKey,
              reviewed.get(round.versionNo) ?? [],
              latest,
            ),
          })),
        };
      }),
    };
  }

  async open(draftId: string, dto: OpenReviewRoundDto, actor: Principal) {
    const { draft, editable } = await this.drafts.access(draftId, actor);
    if (!editable) this.closedRequest();
    const round = await this.transactions.execute(async (tx) => {
      const open = await tx.contractReviewRound.findFirst({
        where: { draftId, status: 'open' },
        select: { roundNo: true },
      });
      if (open) {
        throw new AppError(
          'CONFLICT',
          `รอบตรวจที่ ${open.roundNo} ยังเปิดอยู่ — ปิดรอบนั้นก่อน`,
        );
      }
      const last = await tx.contractReviewRound.findFirst({
        where: { draftId },
        orderBy: { roundNo: 'desc' },
        select: { roundNo: true },
      });
      // (draftId, roundNo) is unique: two opens at once cannot both land
      return tx.contractReviewRound.create({
        data: {
          companyId: draft.companyId,
          draftId,
          roundNo: (last?.roundNo ?? 0) + 1,
          versionNo: draft.latestVersionNo,
          note: dto.note?.trim() || null,
          openedBy: actor.userId,
        },
      });
    });
    await this.audit.record({
      eventType: 'legal.review.opened',
      companyId: draft.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: draft.requestId,
      after: {
        draftId,
        roundNo: round.roundNo,
        versionNo: round.versionNo,
      },
    });
    return this.list(draftId, actor);
  }

  async comment(roundId: string, dto: ReviewCommentDto, actor: Principal) {
    const { round, draftId } = await this.openRound(roundId, actor);
    const body = dto.body?.trim();
    if (!body) {
      throw new AppError('VALIDATION_FAILED', 'ต้องเขียนความเห็น', [
        { field: 'body', reason: 'required' },
      ]);
    }
    const clause = (await this.drafts.clausesOf(draftId, round.versionNo)).find(
      (row) => row.key === dto.clause_key,
    );
    if (!clause) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ไม่มีข้อนี้ในร่างฉบับที่ ${round.versionNo}`,
        [{ field: 'clause_key', reason: 'unknown' }],
      );
    }
    await this.comments.create({
      data: {
        roundId,
        clauseKey: clause.key,
        clauseHeading: clause.heading,
        body,
        createdBy: actor.userId,
      },
    });
    return this.list(draftId, actor);
  }

  async answer(
    commentId: string,
    dto: AnswerReviewCommentDto,
    actor: Principal,
  ) {
    const found = (await this.comments.findFirst({
      where: { id: commentId },
      select: { roundId: true },
    })) as { roundId: string } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบความเห็นที่ระบุ');
    const { draftId, draft } = await this.openRound(found.roundId, actor);
    const problem = answerProblem(dto.status, dto.response);
    if (problem) {
      throw new AppError('VALIDATION_FAILED', problem, [
        { field: 'answer', reason: problem },
      ]);
    }
    await this.comments.update({
      where: { id: commentId },
      data: {
        status: dto.status,
        response: dto.response?.trim() || null,
        respondedBy: actor.userId,
        respondedAt: new Date(),
        resolvedInVersion:
          dto.status === 'resolved' ? draft.latestVersionNo : null,
      },
    });
    return this.list(draftId, actor);
  }

  /** Close the round — refused while any comment is unanswered. */
  async close(roundId: string, actor: Principal) {
    const { round, draftId, draft } = await this.openRound(roundId, actor);
    await this.transactions.execute(async (tx) => {
      const unanswered = await tx.contractReviewComment.count({
        where: { roundId, status: 'open' },
      });
      if (unanswered) {
        throw new AppError(
          'CONFLICT',
          `ยังมีความเห็นที่ไม่ได้ตอบ ${unanswered} ข้อ — ตอบให้ครบก่อนปิดรอบ`,
        );
      }
      const closed = await tx.contractReviewRound.updateMany({
        where: { id: roundId, status: 'open' },
        data: {
          status: 'closed',
          closedBy: actor.userId,
          closedAt: new Date(),
          closedVersionNo: draft.latestVersionNo,
        },
      });
      if (closed.count !== 1) {
        throw new AppError('CONFLICT', 'รอบตรวจนี้ปิดไปแล้ว');
      }
    });
    await this.audit.record({
      eventType: 'legal.review.closed',
      companyId: round.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: draft.requestId,
      after: {
        draftId,
        roundNo: round.roundNo,
        closedVersionNo: draft.latestVersionNo,
      },
    });
    return this.list(draftId, actor);
  }

  /** Two versions clause by clause. */
  async compare(draftId: string, from: number, to: number, actor: Principal) {
    await this.drafts.access(draftId, actor);
    const [before, after] = await Promise.all([
      this.drafts.clausesOf(draftId, from),
      this.drafts.clausesOf(draftId, to),
    ]);
    const clauses = compareVersions(before, after);
    return {
      from,
      to,
      clauses,
      counts: {
        changed: clauses.filter((row) => row.change === 'changed').length,
        added: clauses.filter((row) => row.change === 'added').length,
        removed: clauses.filter((row) => row.change === 'removed').length,
      },
    };
  }

  // --- helpers -------------------------------------------------------------

  private async openRound(roundId: string, actor: Principal) {
    const round = await this.rounds.findFirst({
      where: { id: roundId, companyId: actor.activeCompanyId },
    });
    if (!round) throw new AppError('NOT_FOUND', 'ไม่พบรอบตรวจที่ระบุ');
    const { draft, editable } = await this.drafts.access(round.draftId, actor);
    if (!editable) this.closedRequest();
    if (round.status !== 'open') {
      throw new AppError('CONFLICT', 'รอบตรวจนี้ปิดแล้ว');
    }
    return { round, draft, draftId: round.draftId };
  }

  private closedRequest(): never {
    throw new AppError(
      'CONFLICT',
      'คำขอนี้ไม่ได้อยู่ระหว่างดำเนินการ — ตรวจร่างไม่ได้',
    );
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
