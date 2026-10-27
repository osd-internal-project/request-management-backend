/**
 * เหตุการณ์ใน CTD → เริ่ม workflow บน OSD Workflow (22 ต.ค. 2569): the rules,
 * apart from the database and the network — which events can start a
 * workflow, what each one sends, when to retry, and what a trigger may hold.
 *
 * "Workflow owns Process, Core owns Data": core only says what happened to
 * its data and hands over the ids; the workflow decides what to do with it.
 */
import { DOMAIN_EVENTS, type DomainEvent } from '../events/event-catalog';

export { nextAttemptDelayMs } from '../webhook/webhook-rules';

/** Calling a channel's start should answer in seconds — it only opens an instance. */
export const START_TIMEOUT_MS = 15_000;

/** What `variables` the workflow's Start receives — fixed per event (decision 3). */
export type TriggerVariables = Record<string, string>;

interface TriggerEventSpec {
  /** Shown in the admin screen. */
  label: string;
  /** What the resource id of a start is. */
  resourceType: string;
  /** The workflow's Start inputs this event sends, in order. */
  variables: readonly string[];
  /**
   * What a trigger may narrow the event on — the payload field whose value must
   * be one of the trigger's `typeCodes`, and what those codes are; none = every
   * occurrence starts the workflow.
   */
  filter: TriggerFilter | null;
  resourceIdOf(payload: Record<string, unknown>): string;
  variablesOf(payload: Record<string, unknown>): TriggerVariables;
}

/**
 * `request_type`: request type codes (`SOL`, `FI05`). `lead_status`: a company's
 * lead status codes from CRM settings (`qualified`) — configuration, so the
 * screen offers whatever codes exist and nothing here names one.
 */
export type TriggerFilterKind = 'request_type' | 'lead_status';

interface TriggerFilter {
  kind: TriggerFilterKind;
  field: string;
  /** What a code must look like — the owning module's own rule. */
  pattern: RegExp;
}

const REQUEST_TYPE_FILTER: TriggerFilter = {
  kind: 'request_type',
  field: 'type_code',
  // as request.dto's request-type code
  pattern: /^[A-Z0-9_]{1,40}$/,
};

/** Same as lead-status.service CODE_PATTERN. */
const LEAD_STATUS_FILTER: TriggerFilter = {
  kind: 'lead_status',
  field: 'status',
  pattern: /^[a-z][a-z0-9_]{0,29}$/,
};

/** `-` is what a workflow template reads as "none" (see process-refs.dto). */
const NONE = '-';
const text = (value: unknown): string =>
  value === null || value === undefined || value === '' ? NONE : String(value);

const requestEvent = (label: string): TriggerEventSpec => ({
  label,
  resourceType: 'request',
  variables: ['requestId', 'requestNo', 'typeCode', 'companyId'],
  filter: REQUEST_TYPE_FILTER,
  resourceIdOf: (p) => String(p.request_id),
  variablesOf: (p) => ({
    requestId: text(p.request_id),
    requestNo: text(p.request_no),
    typeCode: text(p.type_code),
    companyId: text(p.company_id),
  }),
});

/**
 * Round 1 (22 ต.ค.): the events that are domain events already. CRM/PM/billing
 * moments that are only audit entries today come in round 2, once they are
 * emitted after their commit.
 */
export const WORKFLOW_TRIGGER_EVENTS: Readonly<
  Record<string, TriggerEventSpec>
> = {
  [DOMAIN_EVENTS.leadCreated]: {
    label: 'สร้าง Lead',
    resourceType: 'lead',
    // the same three LeadWorkflowSyncService has always sent
    variables: ['leadId', 'leadName', 'companyId'],
    filter: null,
    resourceIdOf: (p) => String(p.lead_id),
    variablesOf: (p) => ({
      leadId: text(p.lead_id),
      leadName: text(p.name),
      companyId: text(p.company_id),
    }),
  },
  /*
    27 ต.ค. 2569: the stage-1 workflow starts when the Lead passes screening in
    CTD (status `qualified`), not when it is keyed in — CTD owns qualifying, the
    workflow picks up from there. One start per lead per trigger (the
    workflow_starts unique key), so a Lead that goes back and forth starts once.
  */
  [DOMAIN_EVENTS.leadStatusChanged]: {
    label: 'Lead เปลี่ยนสถานะ',
    resourceType: 'lead',
    variables: ['leadId', 'leadName', 'status', 'previousStatus', 'companyId'],
    filter: LEAD_STATUS_FILTER,
    resourceIdOf: (p) => String(p.lead_id),
    variablesOf: (p) => ({
      leadId: text(p.lead_id),
      leadName: text(p.name),
      status: text(p.status),
      previousStatus: text(p.previous_status),
      companyId: text(p.company_id),
    }),
  },
  [DOMAIN_EVENTS.leadConverted]: {
    label: 'แปลง Lead เป็นโอกาสการขาย',
    resourceType: 'lead',
    variables: ['leadId', 'opportunityId', 'opportunityNo', 'companyId'],
    filter: null,
    resourceIdOf: (p) => String(p.lead_id),
    variablesOf: (p) => ({
      leadId: text(p.lead_id),
      opportunityId: text(p.opportunity_id),
      opportunityNo: text(p.opportunity_code),
      companyId: text(p.company_id),
    }),
  },
  [DOMAIN_EVENTS.requestSubmitted]: requestEvent('ยื่นคำขอ'),
  [DOMAIN_EVENTS.requestApproved]: requestEvent('คำขอได้รับอนุมัติ'),
  [DOMAIN_EVENTS.requestCompleted]: requestEvent('คำขอปิดงานแล้ว'),
  [DOMAIN_EVENTS.esignCompleted]: {
    label: 'ลงนามอิเล็กทรอนิกส์ครบ',
    resourceType: 'esign_envelope',
    variables: ['envelopeId', 'refType', 'refId', 'companyId'],
    filter: null,
    resourceIdOf: (p) => String(p.envelope_id),
    variablesOf: (p) => ({
      envelopeId: text(p.envelope_id),
      refType: text(p.ref_type),
      refId: text(p.ref_id),
      companyId: text(p.company_id),
    }),
  },
};

export const TRIGGER_EVENT_KEYS = Object.keys(WORKFLOW_TRIGGER_EVENTS);

/**
 * Events whose trigger starts a workflow for a Lead. While a company has an
 * active one, the env path (LeadWorkflowSyncService) stays out — otherwise
 * moving the start to `lead.status_changed` and switching `lead.created` off
 * would hand every new Lead back to WORKFLOW_CHANNEL_*.
 */
export const LEAD_START_EVENT_KEYS: readonly string[] =
  TRIGGER_EVENT_KEYS.filter(
    (key) => WORKFLOW_TRIGGER_EVENTS[key].resourceType === 'lead',
  );

/** The start rows an event asks for — resource, and the variables snapshot. */
export function startOf(event: Pick<DomainEvent, 'name' | 'payload'>): {
  resourceType: string;
  resourceId: string;
  variables: TriggerVariables;
} | null {
  const spec = WORKFLOW_TRIGGER_EVENTS[event.name];
  if (!spec) return null;
  const payload = event.payload as unknown as Record<string, unknown>;
  return {
    resourceType: spec.resourceType,
    resourceId: spec.resourceIdOf(payload),
    variables: spec.variablesOf(payload),
  };
}

/** A trigger narrowed to some codes counts only those; none = all. */
export function matchesTypes(
  typeCodes: readonly string[],
  payload: Record<string, unknown>,
  field = 'type_code',
): boolean {
  if (typeCodes.length === 0) return true;
  const value = payload[field];
  return typeof value === 'string' && typeCodes.includes(value);
}

/** The trigger's codes against this event's filter field. */
export function matchesEvent(
  eventKey: string,
  typeCodes: readonly string[],
  payload: Record<string, unknown>,
): boolean {
  const filter = WORKFLOW_TRIGGER_EVENTS[eventKey]?.filter;
  return filter ? matchesTypes(typeCodes, payload, filter.field) : true;
}

/** Sample values for the admin's "test" — one per variable the event sends. */
export function sampleVariables(
  eventKey: string,
  companyId: string,
): TriggerVariables {
  const spec = WORKFLOW_TRIGGER_EVENTS[eventKey];
  return Object.fromEntries(
    (spec?.variables ?? []).map((name) => [
      name,
      name === 'companyId' ? companyId : `TEST-${name}`,
    ]),
  );
}

/** OSD Workflow channel ids are lowercase alphanumerics (cuid). */
const CHANNEL_ID = /^[a-z0-9]{10,64}$/;

export function triggerProblems(input: {
  eventKey?: string;
  typeCodes?: readonly string[];
  channelId?: string;
}): { field: string; reason: string }[] {
  const problems: { field: string; reason: string }[] = [];
  const spec = input.eventKey
    ? WORKFLOW_TRIGGER_EVENTS[input.eventKey]
    : undefined;
  if (input.eventKey !== undefined && !spec) {
    problems.push({
      field: 'event_key',
      reason: `ไม่รู้จักเหตุการณ์ ${input.eventKey}`,
    });
  }
  const codes = input.typeCodes ?? [];
  if (spec && !spec.filter && codes.length > 0) {
    problems.push({
      field: 'type_codes',
      reason: 'เหตุการณ์นี้กรองไม่ได้ — กรองได้เฉพาะประเภทคำขอหรือสถานะ Lead',
    });
  }
  const filter = spec?.filter;
  const bad = filter ? codes.filter((code) => !filter.pattern.test(code)) : [];
  if (filter && bad.length > 0) {
    problems.push({
      field: 'type_codes',
      reason:
        filter.kind === 'lead_status'
          ? `รหัสสถานะ Lead ไม่ถูกต้อง: ${bad.join(', ')} (ตัวพิมพ์เล็ก เช่น qualified)`
          : `รหัสประเภทคำขอไม่ถูกต้อง: ${bad.join(', ')}`,
    });
  }
  if (input.channelId !== undefined && !CHANNEL_ID.test(input.channelId)) {
    problems.push({
      field: 'channel_id',
      reason:
        'Channel ID ต้องเป็นตัวอักษรเล็ก/ตัวเลข 10–64 ตัว (คัดจากหน้า Delivery channels)',
    });
  }
  return problems;
}
