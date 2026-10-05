/**
 * CD-219 เชื่อมต่อระบบ — the rules, apart from the database: what an
 * integration point needs, who answers for it, and the test that proves it.
 */

export const DIRECTIONS = ['outbound', 'inbound', 'both'] as const;
export const MAX_INTEGRATION_TEXT = 4000;

const ARROW: Record<string, string> = {
  outbound: '→',
  inbound: '←',
  both: '⇄',
};

/** An integration point's own problems, in Thai. */
export function integrationProblems(input: {
  name: string;
  targetSystem: string;
  direction: string;
  contactId: string | null;
  contactName: string;
  contactEmail: string;
}): string[] {
  const problems: string[] = [];
  if (!input.name.trim()) problems.push('ต้องตั้งชื่อจุดเชื่อมต่อ');
  if (input.name.length > 200) problems.push('ชื่อยาวเกิน 200 ตัวอักษร');
  if (!input.targetSystem.trim())
    problems.push('ต้องระบุระบบของลูกค้าที่เชื่อมด้วย');
  if (input.targetSystem.length > 200) {
    problems.push('ชื่อระบบยาวเกิน 200 ตัวอักษร');
  }
  if (!(DIRECTIONS as readonly string[]).includes(input.direction)) {
    problems.push('ทิศทางต้องเป็น ส่งออก รับเข้า หรือสองทาง');
  }
  if (!input.contactId && !input.contactName.trim()) {
    problems.push('ต้องระบุผู้รับผิดชอบฝั่งลูกค้า');
  }
  if (input.contactEmail && !/^\S+@\S+\.\S+$/.test(input.contactEmail)) {
    problems.push('อีเมลผู้รับผิดชอบไม่ถูกต้อง');
  }
  return problems;
}

/** The connection test's wording, as it shows in the test plan (CD-221). */
export function integrationTestText(input: {
  seq: number;
  name: string;
  targetSystem: string;
  direction: string;
}): string {
  return `I-${input.seq} ทดสอบการเชื่อมต่อ ${input.name} ${ARROW[input.direction] ?? '⇄'} ${input.targetSystem}`;
}
