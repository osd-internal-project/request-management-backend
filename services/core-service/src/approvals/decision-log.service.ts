import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ApprovalCaseRepository,
  type DecisionLogStep,
} from './approval-case.repository';
import type {
  DecisionBasis,
  DecisionLogQueryDto,
} from './dto/decision-log.dto';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A spreadsheet an executive can open; past this, narrow the window. */
export const EXPORT_MAX_ROWS = 10_000;

const bangkokDate = (instant: Date) =>
  new Date(instant.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);

/** `[start, end)` of inclusive Bangkok dates; defaults to this month so far. */
export function decisionWindow(
  query: Pick<DecisionLogQueryDto, 'from' | 'to'>,
  now: Date = new Date(),
) {
  const today = bangkokDate(now);
  const from = query.from ?? `${today.slice(0, 8)}01`;
  const to = query.to ?? today;
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - BANGKOK_OFFSET_MS);
  const end = new Date(
    Date.parse(`${to}T00:00:00Z`) - BANGKOK_OFFSET_MS + DAY_MS,
  );

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    bangkokDate(start) !== from ||
    bangkokDate(new Date(end.getTime() - DAY_MS)) !== to
  ) {
    throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง', [
      { field: 'from', reason: 'invalid_date' },
    ]);
  }
  if (end <= start) {
    throw new AppError('VALIDATION_FAILED', 'วันเริ่มต้องไม่เกินวันสิ้นสุด', [
      { field: 'from', reason: 'after_to' },
    ]);
  }
  return { from, to, start, end };
}

/** Who was entitled to decide, compared with who did. */
export function basisOf(step: {
  delegationId: string | null;
  decidedByUserId: string | null;
  approverUserId: string | null;
  candidateUserIds: string[];
}): DecisionBasis {
  if (step.delegationId) return 'delegate';
  const actor = step.decidedByUserId;
  if (
    !actor ||
    actor === step.approverUserId ||
    step.candidateUserIds.includes(actor)
  ) {
    return 'chain';
  }
  return 'scope_grant';
}

export interface DecisionLogRow {
  step_id: string;
  case_id: string;
  decided_at: Date | null;
  request_id: string | null;
  request_no: string | null;
  type_code: string | null;
  subject_type: string;
  amount: number | null;
  currency: string | null;
  step_no: number;
  approver_role: string;
  approver_name: string | null;
  decided_by_name: string | null;
  basis: DecisionBasis;
  decision: string | null;
  note: string | null;
  case_status: string;
  /** "ด้วยข้อมูลชุดใด" — the matrix version it was routed under and the snapshot it was judged on. */
  matrix_version: number | null;
  snapshot_version: number;
  snapshot_hash: string;
}

function toRow(step: DecisionLogStep): DecisionLogRow {
  return {
    step_id: step.id,
    case_id: step.case.id,
    decided_at: step.decidedAt,
    request_id: step.case.request?.id ?? null,
    request_no: step.case.request?.requestNo ?? null,
    type_code: step.case.request?.typeCode ?? null,
    subject_type: step.case.subjectType,
    amount: step.case.amount === null ? null : Number(step.case.amount),
    currency: step.case.currency,
    step_no: step.stepNo,
    approver_role: step.approverRole,
    approver_name: step.approver?.displayName ?? null,
    decided_by_name: step.decidedBy?.displayName ?? null,
    basis: basisOf(step),
    decision: step.decision,
    note: step.note,
    case_status: step.case.status,
    matrix_version: step.case.matrixVersion,
    snapshot_version: step.case.snapshotVersion,
    snapshot_hash: step.case.snapshotHash,
  };
}

const CSV_BASIS: Record<DecisionBasis, string> = {
  chain: 'ตามสายอนุมัติ',
  delegate: 'แทน (มอบอำนาจ)',
  scope_grant: 'สิทธิ์ขอบเขต (นอกสาย)',
};
const CSV_DECISION: Record<string, string> = {
  approve: 'อนุมัติ',
  reject: 'ไม่อนุมัติ',
  return: 'ตีกลับ',
};

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  // RFC 4180 + a leading quote on formula starters so Excel never evaluates
  // a note someone typed as "=HYPERLINK(...)".
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const bangkokDateTime = (instant: Date | null) =>
  instant
    ? new Date(instant.getTime() + BANGKOK_OFFSET_MS)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')
    : '';

/**
 * APV-06 (CD-45) — ประวัติการใช้อำนาจอนุมัติ: ใครตัดสินอะไร เมื่อไร ในฐานะอะไร
 * (ตามสาย / แทน / สิทธิ์ขอบเขตนอกสาย) และด้วยข้อมูลชุดใด (เวอร์ชันตาราง + snapshot).
 * หนึ่งแถว = การตัดสินหนึ่งครั้งของหนึ่งขั้น. export เป็น CSV ได้ และทุกการ export
 * ถูกบันทึก audit พร้อมตัวกรองและจำนวนแถว.
 *
 * อ่านได้ด้วย `approval.history.read` เท่านั้น ในบริษัทที่ทำงานอยู่ (SCOPE-03).
 */
@Injectable()
export class DecisionLogService {
  constructor(
    private readonly cases: ApprovalCaseRepository,
    private readonly audit: AuditWriter,
  ) {}

  async list(query: DecisionLogQueryDto, actor: Principal) {
    const { skip, take } = toSkipTake(query);
    const window = decisionWindow(query);
    const where = await this.where(query, actor, window);

    const [steps, total] = await Promise.all([
      this.cases.decidedSteps(where, { skip, take }),
      this.cases.countDecidedSteps(where),
    ]);

    return {
      ...paginated(steps.map(toRow), query, total),
      period: { from: window.from, to: window.to },
    };
  }

  async exportCsv(
    query: DecisionLogQueryDto,
    actor: Principal,
  ): Promise<{ filename: string; body: Buffer; rows: number }> {
    const window = decisionWindow(query);
    const where = await this.where(query, actor, window);

    const total = await this.cases.countDecidedSteps(where);
    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ข้อมูล ${total.toLocaleString('th-TH')} แถว เกิน ${EXPORT_MAX_ROWS.toLocaleString('th-TH')} แถว — แคบช่วงเวลาลง`,
        [{ field: 'from', reason: 'too_many_rows' }],
      );
    }

    const rows = (
      await this.cases.decidedSteps(where, { skip: 0, take: EXPORT_MAX_ROWS })
    ).map(toRow);

    const header = [
      'วันเวลาที่ตัดสิน',
      'เลขคำขอ',
      'ประเภท',
      'เรื่อง',
      'มูลค่า',
      'สกุลเงิน',
      'ขั้น',
      'ตำแหน่งผู้อนุมัติ',
      'ผู้อนุมัติตามสาย',
      'ผู้ตัดสิน',
      'ในฐานะ',
      'ผลการตัดสิน',
      'หมายเหตุ',
      'สถานะเรื่อง',
      'เวอร์ชันตารางอนุมัติ',
      'snapshot',
    ];
    const lines = rows.map((row) =>
      [
        bangkokDateTime(row.decided_at),
        row.request_no,
        row.type_code,
        row.subject_type,
        row.amount,
        row.currency,
        row.step_no,
        row.approver_role,
        row.approver_name,
        row.decided_by_name,
        CSV_BASIS[row.basis],
        row.decision ? (CSV_DECISION[row.decision] ?? row.decision) : '',
        row.note,
        row.case_status,
        row.matrix_version,
        `v${row.snapshot_version} ${row.snapshot_hash.slice(0, 12)}`,
      ]
        .map(csvCell)
        .join(','),
    );
    // BOM so Excel opens Thai as UTF-8 instead of guessing a code page.
    const body = Buffer.from(
      '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n',
      'utf8',
    );

    await this.audit.record({
      eventType: 'approval.decisions.exported',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'approval_decision_log',
      resourceId: actor.activeCompanyId,
      after: {
        from: window.from,
        to: window.to,
        subjectType: query.subject_type ?? null,
        decidedBy: query.decided_by ?? null,
        basis: query.basis ?? null,
        rows: rows.length,
      },
    });

    return {
      filename: `approval-decisions_${window.from}_${window.to}.csv`,
      body,
      rows: rows.length,
    };
  }

  private async where(
    query: DecisionLogQueryDto,
    actor: Principal,
    window: { start: Date; end: Date },
  ): Promise<Prisma.ApprovalStepWhereInput> {
    const where: Prisma.ApprovalStepWhereInput = {
      decision: { not: null },
      decidedAt: { gte: window.start, lt: window.end },
      case: {
        companyId: actor.activeCompanyId,
        ...(query.subject_type ? { subjectType: query.subject_type } : {}),
      },
      ...(query.decided_by ? { decidedByUserId: query.decided_by } : {}),
    };

    if (query.basis) {
      const ids = await this.cases.stepIdsByBasis(
        actor.activeCompanyId,
        window,
        query.basis,
      );
      where.id = { in: ids };
    }
    return where;
  }
}
