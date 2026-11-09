import type { Permission, Principal } from '@request-management/share';

export const VENDORS = ['vuvagent'] as const;
export type Vendor = (typeof VENDORS)[number];

interface AgentActionSpec {
  read: Permission;
  start: Permission;
  /** which `outbound_connections` row carries the job */
  vendor: Vendor;
  /** used until the admin sets one on the connection */
  defaultTimeoutMinutes: number;
  /** body keys sent to the vendor, shown on the Integrations screen */
  payloadFields: readonly string[];
}

/**
 * งานที่ส่งให้ agent ได้ และสิทธิ์ของแต่ละงาน — `read` ดู record, `start` สั่งงาน.
 * สิทธิ์ผูกต่อ action ไม่ใช่ทั้งตาราง: ผู้ที่อ่าน Lead ได้ต้องไม่เห็นงานของโมดูลอื่น.
 */
export const AGENT_ACTIONS = {
  'lead.find': {
    read: 'crm.lead.read',
    start: 'crm.lead.manage',
    vendor: 'vuvagent',
    defaultTimeoutMinutes: 30,
    payloadFields: ['agent_record_id', 'topic'],
  },
  /** the agent merges what it finds into `intakeData.research` itself */
  'lead.research': {
    read: 'crm.lead.read',
    start: 'crm.lead.manage',
    vendor: 'vuvagent',
    defaultTimeoutMinutes: 30,
    payloadFields: ['agent_record_id', 'lead_id', 'focus'],
  },
  /** Proposal Writer step 1; the agent also merges `intakeData.product_suggestions` */
  'lead.suggest_products': {
    read: 'crm.lead.read',
    start: 'crm.lead.manage',
    vendor: 'vuvagent',
    defaultTimeoutMinutes: 10,
    payloadFields: ['agent_record_id', 'lead_id'],
  },
  /** Proposal Writer step 2; closing it makes CTD fetch the .docx (docs/lead-proposal.md) */
  'lead.write_proposal': {
    read: 'crm.lead.read',
    start: 'crm.lead.manage',
    vendor: 'vuvagent',
    defaultTimeoutMinutes: 30,
    payloadFields: ['agent_record_id', 'lead_id', 'product'],
  },
} as const satisfies Record<string, AgentActionSpec>;

export type AgentAction = keyof typeof AGENT_ACTIONS;

export function isAgentAction(value: string): value is AgentAction {
  return Object.hasOwn(AGENT_ACTIONS, value);
}

export const AGENT_RECORD_STATUSES = ['processing', 'done', 'failed'] as const;
export type AgentRecordStatus = (typeof AGENT_RECORD_STATUSES)[number];

/** Actions whose records this caller may read; empty means none. */
export function readableActions(principal: Principal): AgentAction[] {
  return (Object.keys(AGENT_ACTIONS) as AgentAction[]).filter((action) =>
    principal.permissions.includes(AGENT_ACTIONS[action].read),
  );
}
