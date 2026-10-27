import type { Permission, Principal } from '@request-management/share';

/**
 * งานที่ส่งให้ agent ได้ และสิทธิ์ของแต่ละงาน — `read` ดู record, `start` สั่งงาน.
 * สิทธิ์ผูกต่อ action ไม่ใช่ทั้งตาราง: ผู้ที่อ่าน Lead ได้ต้องไม่เห็นงานของโมดูลอื่น.
 */
export const AGENT_ACTIONS = {
  'lead.find': { read: 'crm.sales.read', start: 'crm.sales.manage' },
} as const satisfies Record<string, { read: Permission; start: Permission }>;

export type AgentAction = keyof typeof AGENT_ACTIONS;

export const AGENT_RECORD_STATUSES = ['processing', 'done', 'failed'] as const;
export type AgentRecordStatus = (typeof AGENT_RECORD_STATUSES)[number];

/** Actions whose records this caller may read; empty means none. */
export function readableActions(principal: Principal): AgentAction[] {
  return (Object.keys(AGENT_ACTIONS) as AgentAction[]).filter((action) =>
    principal.permissions.includes(AGENT_ACTIONS[action].read),
  );
}
