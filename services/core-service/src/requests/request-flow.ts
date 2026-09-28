import { AppError, ErrorDetail } from '@request-management/share';
import {
  assertReceiverFormComplete,
  missingRequiredSubRequests,
  type SubRequestTypeRule,
} from './submit-rules';
import { OPEN_STATUSES } from './request-state-machine';

/**
 * A request type's configurable flow: the steps a request walks inside
 * `in_progress`. Pure functions only — the service owns every write.
 */

export const CONDITION_OPS = [
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'in',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface FlowCondition {
  readonly field: string;
  readonly op: ConditionOp;
  readonly value: unknown;
}

export type AssigneeRule =
  | { readonly type: 'keep' }
  | { readonly type: 'requester' }
  | { readonly type: 'user'; readonly userId: string };

export interface FlowStep {
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly formSchema: unknown;
  readonly subRequestTypes: readonly SubRequestTypeRule[];
  readonly requiresApproval: boolean;
  readonly assigneeRule: AssigneeRule | null;
  readonly slaHours: number | null;
  /** v2 only: the status this step sits under (v1 steps are all `in_progress`). */
  readonly scopeStatus?: string;
  readonly receiverRule?: ReceiverRule | null;
  readonly returnToStepCode?: string | null;
  /** v2 approval steps: the ladder, checked by `assertValidLevels`. */
  readonly approvalLevels?: unknown;
  readonly requiredDocs?: readonly {
    code: string;
    name: string;
    required?: boolean;
  }[];
}

/** v2 work steps: who receives the work on entry. */
export type ReceiverRule =
  | { readonly type: 'keep' }
  | { readonly type: 'receiver' }
  | { readonly type: 'user'; readonly userId: string }
  | { readonly type: 'step'; readonly stepCode: string };

export interface FlowTransition {
  readonly fromStepCode: string;
  readonly toStepCode: string;
  readonly sortOrder: number;
  readonly condition: FlowCondition | null;
  readonly backward: boolean;
}

export interface Flow {
  readonly steps: readonly FlowStep[];
  readonly transitions: readonly FlowTransition[];
  /** 1: steps inside `in_progress`; 2: steps cover the lifecycle under status scopes. */
  readonly schemaVersion?: number;
}

/** A child request as the exit check needs it. */
export interface StepChild {
  readonly typeCode: string;
  readonly status: string;
  readonly parentStepCode: string | null;
  readonly requestNo: string | null;
}

const STEP_CODE = /^[A-Z0-9_]{1,32}$/;

export function firstStep(flow: Flow): FlowStep {
  const [first] = [...flow.steps].sort((a, b) => a.sortOrder - b.sortOrder);
  if (!first) {
    throw new AppError('REQ_STEP_INVALID', 'flow นี้ไม่มีขั้นตอน');
  }
  return first;
}

export function stepOf(flow: Flow, code: string | null): FlowStep {
  const step = flow.steps.find((candidate) => candidate.code === code);
  if (!step) {
    throw new AppError('REQ_STEP_INVALID', 'ไม่พบขั้นตอนที่ระบุ', [
      { field: 'step', reason: code ?? 'null' },
    ]);
  }
  return step;
}

function exitsFrom(flow: Flow, code: string, backward: boolean) {
  return flow.transitions
    .filter((exit) => exit.fromStepCode === code && exit.backward === backward)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** A step with no forward exit is where the work finishes (`complete`). */
export function isLastStep(flow: Flow, code: string): boolean {
  return exitsFrom(flow, code, false).length === 0;
}

/** The forward exit taken from `code`: the first whose condition holds. */
export function nextForward(
  flow: Flow,
  code: string,
  answers: Readonly<Record<string, unknown>>,
): string | null {
  const taken = exitsFrom(flow, code, false).find(
    (exit) => !exit.condition || evaluateCondition(exit.condition, answers),
  );
  return taken?.toStepCode ?? null;
}

export function backwardOptions(flow: Flow, code: string): string[] {
  return exitsFrom(flow, code, true).map((exit) => exit.toStepCode);
}

export function evaluateCondition(
  condition: FlowCondition,
  answers: Readonly<Record<string, unknown>>,
): boolean {
  const actual = scalarText(answers[condition.field]);
  if (actual === null || actual === '') return false;

  switch (condition.op) {
    case 'eq':
      return actual === scalarText(condition.value);
    case 'neq':
      return actual !== scalarText(condition.value);
    case 'in':
      return (
        Array.isArray(condition.value) &&
        condition.value.map(scalarText).includes(actual)
      );
    default:
      return compareNumbers(
        Number(actual),
        condition.op,
        Number(condition.value),
      );
  }
}

/** Form answers compared as text; objects and arrays never match. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return null;
}

function compareNumbers(actual: number, op: ConditionOp, expected: number) {
  if (Number.isNaN(actual) || Number.isNaN(expected)) return false;
  if (op === 'gt') return actual > expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lt') return actual < expected;
  return actual <= expected;
}

/** The requester's answers overlaid by every step's answers, for conditions. */
export function answersOf(
  formData: unknown,
  stepFormData: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...asRecord(formData) };
  for (const answers of Object.values(asRecord(stepFormData))) {
    Object.assign(merged, asRecord(answers));
  }
  return merged;
}

export function asRecord(value: unknown): Record<string, unknown> {
  // Narrowed by the checks above; JSON columns arrive as `unknown`.
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Leaving a step forward: its form is answered, its required children raised and closed. */
export function assertStepExitable(
  step: FlowStep,
  stepAnswers: Record<string, unknown>,
  children: readonly StepChild[],
): void {
  assertReceiverFormComplete(step.formSchema, stepAnswers);

  const ofStep = children.filter((child) => child.parentStepCode === step.code);
  const missing = missingRequiredSubRequests(step.subRequestTypes, ofStep);
  if (missing.length) {
    throw new AppError(
      'REQ_SUB_REQUEST_MISSING',
      'ยังไม่ได้สร้างคำขอย่อยที่บังคับของขั้นนี้',
      missing.map((code) => ({ field: 'sub_request_types', reason: code })),
    );
  }

  const open = ofStep.filter((child) =>
    (OPEN_STATUSES as readonly string[]).includes(child.status),
  );
  if (open.length) {
    throw new AppError(
      'REQ_CHILDREN_OPEN',
      'ยังมีคำขอย่อยของขั้นนี้ที่ยังไม่ปิด',
      open.map((child) => ({
        field: 'children',
        reason: child.requestNo ?? '',
      })),
    );
  }
}

/**
 * Refuses a flow that could strand a request: unknown or duplicate codes,
 * forward cycles, unreachable steps, a branch with no unconditional fallback,
 * or a condition on a field no form asks for.
 */
export function assertPublishable(
  flow: Flow,
  knownFields: readonly string[],
): void {
  const details: ErrorDetail[] = [];
  const codes = flow.steps.map((step) => step.code);

  if (!codes.length)
    details.push({ field: 'steps', reason: 'ต้องมีอย่างน้อยหนึ่งขั้น' });

  codes.forEach((code, index) => {
    if (!STEP_CODE.test(code)) {
      details.push({
        field: `steps[${index}].code`,
        reason: 'ใช้ A-Z 0-9 _ ไม่เกิน 32 ตัว',
      });
    } else if (codes.indexOf(code) !== index) {
      details.push({
        field: `steps[${index}].code`,
        reason: `รหัสซ้ำ: ${code}`,
      });
    }
  });

  details.push(...transitionProblems(flow, codes, knownFields));

  if (!details.length) details.push(...graphProblems(flow));

  if (details.length) {
    throw new AppError('VALIDATION_FAILED', 'flow นี้ใช้งานไม่ได้', details);
  }
}

function transitionProblems(
  flow: Flow,
  codes: readonly string[],
  knownFields: readonly string[],
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  flow.transitions.forEach((exit, index) => {
    const field = `transitions[${index}]`;
    if (
      !codes.includes(exit.fromStepCode) ||
      !codes.includes(exit.toStepCode)
    ) {
      details.push({ field, reason: 'อ้างถึงขั้นที่ไม่มีอยู่' });
    }
    if (exit.fromStepCode === exit.toStepCode) {
      details.push({ field, reason: 'ทางออกชี้กลับขั้นเดิม' });
    }
    if (exit.condition) {
      if (exit.backward) {
        details.push({ field, reason: 'ทางย้อนกลับใส่เงื่อนไขไม่ได้' });
      }
      if (!(CONDITION_OPS as readonly string[]).includes(exit.condition.op)) {
        details.push({
          field,
          reason: `ไม่รู้จักตัวดำเนินการ ${exit.condition.op}`,
        });
      }
      if (!knownFields.includes(exit.condition.field)) {
        details.push({
          field,
          reason: `ไม่มีช่อง "${exit.condition.field}" ในฟอร์ม`,
        });
      }
    }
  });

  for (const code of codes) {
    const forward = exitsFrom(flow, code, false);
    const fallback = forward[forward.length - 1];
    if (fallback?.condition) {
      details.push({
        field: `steps.${code}`,
        reason: 'ทางออกสุดท้ายต้องไม่มีเงื่อนไข',
      });
    }
  }

  return details;
}

function graphProblems(flow: Flow): ErrorDetail[] {
  const start = firstStep(flow).code;
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const cycles: string[] = [];

  const walk = (code: string) => {
    if (onPath.has(code)) {
      cycles.push(code);
      return;
    }
    if (visited.has(code)) return;
    visited.add(code);
    onPath.add(code);
    for (const exit of exitsFrom(flow, code, false)) walk(exit.toStepCode);
    onPath.delete(code);
  };
  walk(start);

  const details: ErrorDetail[] = [];
  if (cycles.length) {
    details.push({
      field: `steps.${cycles[0]}`,
      reason: 'ทางไปข้างหน้าวนกลับ — ใช้ทางย้อนกลับแทน',
    });
  }
  for (const step of flow.steps) {
    if (!visited.has(step.code)) {
      details.push({
        field: `steps.${step.code}`,
        reason: 'ไม่มีทางมาถึงขั้นนี้',
      });
    }
  }
  return details;
}
