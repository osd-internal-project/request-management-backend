import { AppError, ErrorDetail } from '@request-management/share';
import { assertValidLevels } from '../approvals/matrix-rules';
import { canTransition } from './request-state-machine';
import {
  assertPublishable,
  isLastStep,
  type Flow,
  type FlowStep,
} from './request-flow';

/**
 * Flow v2: steps cover the whole lifecycle, each under a status scope. The
 * status of a request is the scope of its current step; who holds the step
 * follows from the scope. Pure functions — the service owns every write.
 */

/** The statuses an admin may put a step under; the rest come from actions. */
export const SCOPE_STATUSES = [
  'draft',
  'returned',
  'submitted',
  'in_progress',
  'pending_approval',
  'approved',
] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export type StepRole = 'requester' | 'receiver' | 'worker' | 'approver';

export function isScopeStatus(value: unknown): value is ScopeStatus {
  return (SCOPE_STATUSES as readonly unknown[]).includes(value);
}

export function scopeOf(step: FlowStep): ScopeStatus {
  return isScopeStatus(step.scopeStatus) ? step.scopeStatus : 'in_progress';
}

export function roleOf(scope: ScopeStatus): StepRole {
  if (scope === 'submitted') return 'receiver';
  if (scope === 'in_progress') return 'worker';
  if (scope === 'pending_approval') return 'approver';
  return 'requester';
}

/**
 * Moving between steps under different statuses must be a transition the
 * state machine allows; work finishing into a check passes through `completed`.
 */
export function canMove(from: ScopeStatus, to: ScopeStatus): boolean {
  const target = to === 'draft' && from !== 'draft' ? 'returned' : to;
  if (from === target || canTransition(from, target)) return true;
  return from === 'in_progress' && canTransition('completed', target);
}

/** A draft step reached again after the request was submitted reads as `returned`. */
export function statusOnEntry(
  scope: ScopeStatus,
  submitted: boolean,
): ScopeStatus {
  return scope === 'draft' && submitted ? 'returned' : scope;
}

/** Leaving the requester's hands for the first time — or again after a return — is a submit. */
export function isSubmitMove(fromStatus: string, to: ScopeStatus): boolean {
  const withRequester = (status: string) =>
    status === 'draft' || status === 'returned';
  return withRequester(fromStatus) && !withRequester(to);
}

export interface StepHolderFacts {
  readonly requesterId: string;
  readonly stepHolderUserId: string | null;
  readonly receiverUserId: string | null;
  readonly assigneeUserId: string | null;
}

/** Who acts on a step now; null for an approval step, whose candidates are on its case. */
export function holderOf(
  scope: ScopeStatus,
  request: StepHolderFacts,
): string | null {
  switch (roleOf(scope)) {
    case 'requester':
      return request.stepHolderUserId ?? request.requesterId;
    case 'receiver':
      return request.receiverUserId;
    case 'worker':
      return request.assigneeUserId ?? request.receiverUserId;
    default:
      return null;
  }
}

/** v1's structural checks plus the v2 rules about scopes, ends and approval steps. */
export function assertPublishableV2(
  flow: Flow,
  knownFields: readonly string[],
): void {
  assertPublishable(flow, knownFields);

  const details: ErrorDetail[] = [];
  const byCode = new Map(flow.steps.map((step) => [step.code, step]));
  const ordered = [...flow.steps].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const step of flow.steps) {
    if (!isScopeStatus(step.scopeStatus)) {
      details.push({
        field: `steps.${step.code}.scope`,
        reason: 'เลือกสถานะที่ขั้นนี้อยู่ใต้',
      });
    }
  }
  if (details.length) throw invalidFlow(details);

  if (ordered[0] && scopeOf(ordered[0]) !== 'draft') {
    details.push({
      field: `steps.${ordered[0].code}.scope`,
      reason: 'ขั้นแรกต้องอยู่ใต้ "ร่าง / ยื่นคำขอ"',
    });
  }

  for (const step of flow.steps) {
    const scope = scopeOf(step);
    if (isLastStep(flow, step.code) && scope !== 'approved') {
      details.push({
        field: `steps.${step.code}.scope`,
        reason: 'ขั้นสุดท้ายต้องอยู่ใต้ "อนุมัติแล้ว"',
      });
    }
    if (scope === 'pending_approval')
      details.push(...approvalStepProblems(step, byCode));
    if (scope === 'submitted' && hasForm(step)) {
      details.push({
        field: `steps.${step.code}.form`,
        reason: 'ขั้นรอรับเรื่องไม่มีฟอร์ม',
      });
    }
  }

  for (const exit of flow.transitions) {
    const from = byCode.get(exit.fromStepCode);
    const to = byCode.get(exit.toStepCode);
    if (from && to && !canMove(scopeOf(from), scopeOf(to))) {
      details.push({
        field: `transitions.${exit.fromStepCode}->${exit.toStepCode}`,
        reason: `ย้ายจาก ${scopeOf(from)} ไป ${scopeOf(to)} ไม่ได้`,
      });
    }
  }

  if (details.length) throw invalidFlow(details);
}

function approvalStepProblems(
  step: FlowStep,
  byCode: ReadonlyMap<string, FlowStep>,
): ErrorDetail[] {
  const field = (key: string) => `steps.${step.code}.${key}`;
  const details: ErrorDetail[] = [];

  try {
    assertValidLevels(step.approvalLevels);
  } catch (error) {
    details.push({
      field: field('approvalLevels'),
      reason:
        error instanceof AppError ? error.message : 'ชั้นผู้อนุมัติไม่ถูกต้อง',
    });
  }

  const target = step.returnToStepCode
    ? byCode.get(step.returnToStepCode)
    : undefined;
  if (!target) {
    details.push({
      field: field('returnToStepCode'),
      reason: 'เลือกขั้นที่จะส่งกลับไป',
    });
  } else if (!canMove('pending_approval', scopeOf(target))) {
    details.push({
      field: field('returnToStepCode'),
      reason: `ส่งกลับไป ${scopeOf(target)} ไม่ได้`,
    });
  }

  if (hasForm(step) || step.subRequestTypes.length) {
    details.push({
      field: field('form'),
      reason: 'ขั้นอนุมัติไม่มีฟอร์มหรือคำขอย่อย',
    });
  }
  return details;
}

function hasForm(step: FlowStep): boolean {
  return Boolean(step.formSchema);
}

function invalidFlow(details: ErrorDetail[]): AppError {
  return new AppError('VALIDATION_FAILED', 'flow นี้ใช้งานไม่ได้', details);
}

export type V2Milestone = 'preApproved' | 'completed' | 'approved';

/** Where a request stood, for telling which lifecycle moments a move crossed. */
export interface MilestoneFacts {
  readonly status: string;
  readonly completedAt: Date | null;
}

/**
 * The v1 domain events a v2 move stands for, so CRM consumers keep working:
 * reaching `approved` the first time is work done and accepted; an approval
 * step that hands the ticket to its receiver is a before-work approval.
 */
export function v2Milestones(from: MilestoneFacts, to: MilestoneFacts): V2Milestone[] {
  if (!from.completedAt && to.status === 'approved') return ['completed', 'approved'];
  if (from.status === 'pending_approval' && to.status === 'submitted') return ['preApproved'];
  return [];
}
