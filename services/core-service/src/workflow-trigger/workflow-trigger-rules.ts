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
  /** Request events can be narrowed to some request types. */
  filtersByType: boolean;
  resourceIdOf(payload: Record<string, unknown>): string;
  variablesOf(payload: Record<string, unknown>): TriggerVariables;
}

/** `-` is what a workflow template reads as "none" (see process-refs.dto). */
const NONE = '-';
const text = (value: unknown): string =>
  value === null || value === undefined || value === '' ? NONE : String(value);

const requestEvent = (label: string): TriggerEventSpec => ({
  label,
  resourceType: 'request',
  variables: ['requestId', 'requestNo', 'typeCode', 'companyId'],
  filtersByType: true,
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
    filtersByType: false,
    resourceIdOf: (p) => String(p.lead_id),
    variablesOf: (p) => ({
      leadId: text(p.lead_id),
      leadName: text(p.name),
      companyId: text(p.company_id),
    }),
  },
  [DOMAIN_EVENTS.leadConverted]: {
    label: 'แปลง Lead เป็นโอกาสการขาย',
    resourceType: 'lead',
    variables: ['leadId', 'opportunityId', 'opportunityNo', 'companyId'],
    filtersByType: false,
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
    filtersByType: false,
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

/** The start rows an event asks for — resource, and the variables snapshot. */
export function startOf(
  event: Pick<DomainEvent, 'name' | 'payload'>,
): {
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

/** A trigger narrowed to some request types counts only those; none = all. */
export function matchesTypes(
  typeCodes: readonly string[],
  payload: Record<string, unknown>,
): boolean {
  if (typeCodes.length === 0) return true;
  return (
    typeof payload.type_code === 'string' &&
    typeCodes.includes(payload.type_code)
  );
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
  if (spec && !spec.filtersByType && (input.typeCodes?.length ?? 0) > 0) {
    problems.push({
      field: 'type_codes',
      reason: 'กรองประเภทคำขอได้เฉพาะเหตุการณ์ของคำขอ',
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
