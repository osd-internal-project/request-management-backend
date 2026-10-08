/**
 * CD-288 (CD-23 AI CARE) — how a conversation ended up, the same in the Data
 * Mart, the results screen and the 360° timeline:
 *
 *   case_opened  a service case was opened from it (by AI or the team)
 *   handed_over  a person took part (handed over or taken), no case
 *   ai_resolved  closed with at least one AI answer, no case, no person
 *   no_answer    closed without any AI answer (greeting only, left at once)
 *   live         not closed yet, nothing of the above
 *
 * The AI-closed rate is ai_resolved ÷ (ai_resolved + case_opened +
 * handed_over); no_answer and live are left out of it.
 */

export const CARE_RESULTS = [
  'ai_resolved',
  'case_opened',
  'handed_over',
  'no_answer',
  'live',
] as const;
export type CareResult = (typeof CARE_RESULTS)[number];

export function careResult(c: {
  status: string;
  caseRequestId: string | null;
  humanAt: Date | null;
  aiAnswered: number;
}): CareResult {
  if (c.caseRequestId) return 'case_opened';
  if (c.humanAt) return 'handed_over';
  if (c.status !== 'closed') return 'live';
  return c.aiAnswered > 0 ? 'ai_resolved' : 'no_answer';
}

/** The same rule in SQL: `c` a care_conversations row, `answered` its AI answers. */
export function careResultSql(c: string, answered: string): string {
  return `CASE WHEN ${c}."caseRequestId" IS NOT NULL THEN 'case_opened'
               WHEN ${c}."humanAt" IS NOT NULL THEN 'handed_over'
               WHEN ${c}.status <> 'closed' THEN 'live'
               WHEN COALESCE(${answered}, 0) > 0 THEN 'ai_resolved'
               ELSE 'no_answer' END`;
}

/** AI answers of conversation `c`: AI messages whose search was answered (a LATERAL). */
export function careAnsweredSql(c: string): string {
  return `(SELECT count(*)::int AS n
     FROM care_messages m
     JOIN kb_ai_queries q ON q.id = m."kbQueryId"
     WHERE m."conversationId" = ${c}.id AND m.author = 'ai'
       AND q.outcome = 'answered')`;
}

/** AI-closed rate in %, one decimal; null with nothing decided. */
export function aiClosedPct(counts: {
  ai_resolved: number;
  case_opened: number;
  handed_over: number;
}): number | null {
  const decided = counts.ai_resolved + counts.case_opened + counts.handed_over;
  return decided
    ? Math.round((1000 * counts.ai_resolved) / decided) / 10
    : null;
}

const CHANNEL_TH: Record<string, string> = {
  line: 'LINE',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  email: 'อีเมล',
  web: 'เว็บแชต',
  callcenter: 'คอลเซ็นเตอร์',
  api: 'API',
};

const RESULT_TH: Record<CareResult, string> = {
  ai_resolved: 'AI ตอบจบเอง',
  case_opened: 'เปิดเคส',
  handed_over: 'ส่งต่อเจ้าหน้าที่',
  no_answer: 'ไม่ได้ถามเรื่องใด',
  live: 'ยังคุยอยู่',
};

/** What the 360° timeline says — counts and the result, never message text. */
export function timelineSummary(c: {
  channel: string;
  messages: number;
  result: CareResult;
  caseNo?: string | null;
}): string {
  const result =
    c.result === 'case_opened' && c.caseNo
      ? `เปิดเคส ${c.caseNo}`
      : RESULT_TH[c.result];
  return `บทสนทนา AI CARE ทาง ${CHANNEL_TH[c.channel] ?? c.channel} · ${c.messages} ข้อความ · ${result}`;
}
