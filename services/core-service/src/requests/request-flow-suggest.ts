import { asRecord } from './request-flow';
import type { ScopeStatus } from './request-flow-v2';

/** A type's current settings, as "สร้าง flow จากค่าเดิม" reads them. */
export interface LegacyTypeSettings {
  readonly formSchema: unknown;
  readonly requiredDocs: unknown;
  readonly receiverFormSchema: unknown;
  readonly subRequestTypes: unknown;
  /** The effective `request:<CODE>:pre` ladder, or null. */
  readonly preLevels: readonly unknown[] | null;
  /** The effective after-work `request:<CODE>` ladder, or null. */
  readonly postLevels: readonly unknown[] | null;
}

export interface SuggestedStep {
  code: string;
  name: string;
  scope_status: ScopeStatus;
  form_schema?: Record<string, unknown>;
  required_docs?: unknown[];
  sub_request_types?: unknown[];
  approval_levels?: unknown[];
  return_to_step?: string;
}

export interface SuggestedFlow {
  schema_version: 2;
  steps: SuggestedStep[];
  transitions: { from_step: string; to_step: string }[];
}

/**
 * The fixed lifecycle, restated as v2 steps: request → [pre check] → receive →
 * work → [result check] → requester confirms. Shaped like `PublishFlowDto`.
 */
export function suggestedFlow(type: LegacyTypeSettings): SuggestedFlow {
  const steps: SuggestedStep[] = [
    {
      code: 'REQUEST',
      name: 'ยื่นคำขอ',
      scope_status: 'draft',
      ...formOf(type.formSchema),
      required_docs: listOf(type.requiredDocs),
    },
  ];

  if (type.preLevels?.length) {
    steps.push({
      code: 'PRE_APPROVAL',
      name: 'อนุมัติก่อนทำงาน',
      scope_status: 'pending_approval',
      approval_levels: withChart(type.preLevels, 'requester'),
      return_to_step: 'REQUEST',
    });
  }

  steps.push(
    { code: 'RECEIVE', name: 'รับเรื่อง', scope_status: 'submitted' },
    {
      code: 'WORK',
      name: 'ดำเนินการ',
      scope_status: 'in_progress',
      ...formOf(type.receiverFormSchema),
      sub_request_types: listOf(type.subRequestTypes),
    },
  );

  if (type.postLevels?.length) {
    steps.push({
      code: 'RESULT_APPROVAL',
      name: 'ตรวจรับผลงาน',
      scope_status: 'pending_approval',
      approval_levels: withChart(type.postLevels, 'worker'),
      return_to_step: 'WORK',
    });
  }

  steps.push({
    code: 'CONFIRM',
    name: 'ผู้ขอยืนยันปิดงาน',
    scope_status: 'approved',
  });

  return {
    schema_version: 2,
    steps,
    transitions: steps.slice(1).map((step, index) => ({
      from_step: steps[index].code,
      to_step: step.code,
    })),
  };
}

function formOf(schema: unknown): { form_schema?: Record<string, unknown> } {
  const properties = asRecord(asRecord(schema).properties);
  return Object.keys(properties).length
    ? { form_schema: asRecord(schema) }
    : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A matrix's `supervisor` levels climbed from the chart the old stage used. */
function withChart(
  levels: readonly unknown[],
  chartOf: 'requester' | 'worker',
): unknown[] {
  return levels.map((level) => {
    const fields = asRecord(level);
    return fields.type === 'supervisor' ? { ...fields, chartOf } : fields;
  });
}
