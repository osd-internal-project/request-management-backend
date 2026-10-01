/**
 * CD-186 ประสานงานลูกค้า — the rules of a contact with the customer, apart
 * from the database: what it must say, and which decisions still owe a
 * change request.
 */

export const CONTACT_KINDS = [
  'meeting',
  'call',
  'email',
  'site_visit',
  'other',
] as const;

/** What stops a contact from being saved, in Thai. */
export function logProblems(input: {
  kind: string;
  occurredOn: string | null;
  summary: string;
  decision: string | null;
  affectsScope: boolean;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!(CONTACT_KINDS as readonly string[]).includes(input.kind)) {
    problems.push('ช่องทางไม่ถูกต้อง');
  }
  if (!input.occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    problems.push('ต้องระบุวันที่');
  } else if (input.occurredOn > input.today) {
    problems.push('วันที่ต้องไม่เกินวันนี้');
  }
  if (!input.summary.trim()) problems.push('ต้องสรุปสิ่งที่คุยกัน');
  if (input.affectsScope && !input.decision?.trim()) {
    problems.push('การตัดสินใจที่กระทบขอบเขตต้องระบุว่าลูกค้าตัดสินใจอะไร');
  }
  return problems;
}

/** A decision on the scope that has not become a change request yet. */
export const owesChange = (log: {
  affectsScope: boolean;
  changeRequestId: string | null;
}) => log.affectsScope && !log.changeRequestId;

/** The change request a scope decision becomes. */
export function changeFromLog(log: {
  seq: number;
  occurredOn: string;
  contactName: string | null;
  decision: string;
  summary: string;
}) {
  const label = `C-${log.seq}`;
  return {
    title: `${label}: ${log.decision}`.slice(0, 255),
    reason:
      `ลูกค้าตัดสินใจเมื่อ ${log.occurredOn}` +
      (log.contactName ? ` (${log.contactName})` : '') +
      ` — ${log.summary}`,
    scope_added: log.decision,
  };
}
