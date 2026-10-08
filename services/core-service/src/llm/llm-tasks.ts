/**
 * CD-275 — every AI task the system runs, and what it uses by default. A
 * company changes the model or sets a quota per task on the LLM settings
 * screen; a task not listed here cannot be called (no stray model use).
 */

export type LlmKind = 'chat' | 'embed';

export interface LlmTaskSpec {
  key: string;
  kind: LlmKind;
  label: string;
}

export const LLM_TASKS: readonly LlmTaskSpec[] = [
  { key: 'admin.test', kind: 'chat', label: 'ทดสอบจากหน้าตั้งค่า' },
  {
    key: 'kb.embed',
    kind: 'embed',
    label: 'KBMS — ค้นหาเชิงความหมาย (CD-267)',
  },
  { key: 'kb.answer', kind: 'chat', label: 'KBMS — ร่างคำตอบจากบทความ' },
  {
    key: 'smart.score',
    kind: 'chat',
    label: 'AI SMART — คัดกรองและให้คะแนน Lead',
  },
  {
    key: 'smart.call',
    kind: 'chat',
    label: 'AI SMART — สรุปบทสนทนาการโทรให้ทีมขาย',
  },
  { key: 'care.reply', kind: 'chat', label: 'AI CARE — ตอบลูกค้าเบื้องต้น' },
  { key: 'summary', kind: 'chat', label: 'สรุปข้อความทั่วไป' },
];

export function taskSpec(key: string): LlmTaskSpec | null {
  return LLM_TASKS.find((task) => task.key === key) ?? null;
}
