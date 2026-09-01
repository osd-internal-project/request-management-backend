import { Injectable } from '@nestjs/common';
import {
  accessSubject,
  visibleRequestsWhere,
  PrismaService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Prisma } from '@prisma/client';
import { BottleneckQueryDto } from './dto/report.dto';

/** One row of the report — a step position within a request type. */
export interface BottleneckRow {
  type_code: string;
  step_no: number;
  approver_role: string;
  approver_user_id: string | null;
  decided_count: number;
  pending_count: number;
  mean_hours: number | null;
  max_hours: number | null;
}

/**
 * REQ-09 — where requests actually wait.
 *
 * **Only decided steps contribute a duration.** A step still pending has no
 * end yet, and counting "so far" into a mean would make a queue look faster
 * the longer it stalls. Those are reported separately as `pending_count`,
 * which is the number an operations lead needs anyway.
 *
 * The clock measured is `createdAt → decidedAt` of the step. §11.4 asks for
 * time "excluding the period the clock was stopped"; a return pauses the
 * request-level `SlaClock` and voids the approval case, so a step that
 * survives to a decision was never paused. Where the two could disagree — a
 * hold placed mid-approval — the request-level clock is the authority and is
 * reported by the SLA figures, not here.
 */
@Injectable()
export class BottleneckService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    query: BottleneckQueryDto,
    actor: Principal,
  ): Promise<BottleneckRow[]> {
    const companyId = resolveTargetCompany(actor, query.company_id);

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    const steps = await this.prisma.approvalStep.findMany({
      where: {
        case: {
          companyId,
          ...(query.type_code
            ? { subjectType: `request:${query.type_code}` }
            : {}),
          ...this.visibleCases(actor),
        },
        ...(query.approver_user_id
          ? { approverUserId: query.approver_user_id }
          : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      select: {
        stepNo: true,
        approverRole: true,
        approverUserId: true,
        createdAt: true,
        decidedAt: true,
        case: { select: { subjectType: true } },
      },
    });

    const buckets = new Map<string, BottleneckRow & { total: number }>();

    for (const step of steps) {
      // `request:DSC` → `DSC`; an APV-07 case raised by another module keeps
      // its own subject type, which is still a meaningful grouping.
      const typeCode = step.case.subjectType.replace(/^request:/, '');
      const key = `${typeCode}|${step.stepNo}|${step.approverRole}|${step.approverUserId ?? ''}`;

      const row = buckets.get(key) ?? {
        type_code: typeCode,
        step_no: step.stepNo,
        approver_role: step.approverRole,
        approver_user_id: step.approverUserId,
        decided_count: 0,
        pending_count: 0,
        mean_hours: null as number | null,
        max_hours: null as number | null,
        total: 0,
      };

      if (step.decidedAt) {
        const hours =
          (step.decidedAt.getTime() - step.createdAt.getTime()) / 3_600_000;

        row.decided_count += 1;
        row.total += hours;
        row.max_hours = Math.max(row.max_hours ?? 0, hours);
      } else {
        row.pending_count += 1;
      }

      buckets.set(key, row);
    }

    return (
      [...buckets.values()]
        .map(({ total, ...row }) => ({
          ...row,
          mean_hours: row.decided_count
            ? round2(total / row.decided_count)
            : null,
          max_hours: row.max_hours === null ? null : round2(row.max_hours),
        }))
        // Slowest first: the report exists to answer "where is the queue", and
        // that answer should not need sorting by hand.
        .sort((left, right) => (right.mean_hours ?? 0) - (left.mean_hours ?? 0))
    );
  }

  /**
   * SCOPE-02 — the report may only measure requests the caller can see.
   *
   * This was missing entirely: the query pinned `companyId` and stopped there,
   * so anyone holding `report.request.read` read the whole company's timings
   * regardless of what rows they could open. Permission answers "may you open
   * this report"; this answers "over which rows", and they are not the same
   * test.
   *
   * `request.read.all` needs no extra predicate — the company pin above already
   * expresses it, and adding one would exclude the approval cases that have no
   * request at all (APV-07 lets another module open a case directly). Without
   * that permission those case-only rows are excluded too, because there is no
   * request to judge their visibility by and guessing would leak them.
   */
  private visibleCases(actor: Principal): Prisma.ApprovalCaseWhereInput {
    const subject = accessSubject(actor);
    if (subject.readsWholeCompany) return {};

    return { request: visibleRequestsWhere(subject) };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
