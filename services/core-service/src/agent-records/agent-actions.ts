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
    read: 'crm.sales.read',
    start: 'crm.sales.manage',
    vendor: 'vuvagent',
    defaultTimeoutMinutes: 30,
    payloadFields: ['agent_record_id', 'topic'],
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
