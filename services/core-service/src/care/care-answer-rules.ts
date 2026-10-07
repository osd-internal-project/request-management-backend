import type { ChatMessage } from '../llm/llm-client';

/**
 * CD-281 (CD-23 AI CARE) — answering only from the knowledge base: the
 * model gets the articles the search returned, labelled [A1]…, and must cite
 * them; an answer that cites none, or says it cannot answer, is not sent —
 * the customer is told plainly and offered a case or a person instead.
 */

/** What the model writes when the articles do not answer the question. */
export const NO_ANSWER = 'NO_ANSWER';
/** Articles given to the model, at most. */
export const MAX_ARTICLES = 4;
/** Characters of one article's body the model sees. */
const BODY_CHARS = 3000;
/** Earlier messages the model sees. */
const HISTORY = 10;

export const UNANSWERED_TEXT =
  'ขออภัย ตอนนี้ยังไม่มีข้อมูลเรื่องนี้ในคลังความรู้ของเรา — ' +
  'หากต้องการ เราเปิดเรื่องให้ทีมบริการติดตาม หรือให้เจ้าหน้าที่ติดต่อกลับได้ ' +
  'แจ้งได้เลย';

export const GREETING_TEXT =
  'สวัสดี AI CARE ยินดีช่วยเหลือ — เล่าอาการหรือคำถามมาได้เลย ' +
  'เช่น อุปกรณ์ตัวไหน เกิดอะไรขึ้น ตั้งแต่เมื่อไหร่';

export const UNAVAILABLE_TEXT =
  'ขออภัย ระบบตอบอัตโนมัติขัดข้องชั่วคราว — ' +
  'หากเรื่องเร่งด่วน แจ้งได้เลยว่าต้องการคุยกับเจ้าหน้าที่';

export interface AnswerArticle {
  id: string;
  articleNo: string;
  title: string;
  summary: string | null;
  body: string;
}

export interface AnswerAsset {
  name: string;
  model: string | null;
  coverage: { title: string; endOn: string } | null;
}

export interface AnswerMessage {
  direction: string;
  author: string;
  text: string | null;
}

/** The chat the model is given. */
export function answerPrompt(input: {
  question: string;
  articles: AnswerArticle[];
  history: AnswerMessage[];
  customerName: string | null;
  assets: AnswerAsset[];
}): ChatMessage[] {
  const articles = input.articles
    .slice(0, MAX_ARTICLES)
    .map(
      (a, i) =>
        `[A${i + 1}] ${a.articleNo} — ${a.title}\n` +
        (a.summary ? `${a.summary}\n` : '') +
        a.body.slice(0, BODY_CHARS),
    )
    .join('\n\n---\n\n');
  const equipment = input.assets.length
    ? input.assets
        .map(
          (a) =>
            `- ${a.name}${a.model ? ` (${a.model})` : ''}: ${
              a.coverage
                ? `อยู่ในสิทธิ์บริการ ${a.coverage.title} ถึง ${a.coverage.endOn}`
                : 'ไม่มีสิทธิ์บริการที่มีผล'
            }`,
        )
        .join('\n')
    : null;
  const system = [
    'คุณคือ AI CARE ผู้ช่วยตอบลูกค้าเดิมของบริษัท ตอบเป็นภาษาไทย สุภาพ กระชับ',
    'ตอบได้เฉพาะจากบทความด้านล่างเท่านั้น ห้ามใช้ความรู้อื่นหรือเดา',
    'ทุกประโยคที่ให้ข้อมูลต้องอ้างบทความด้วยป้าย เช่น [A1]',
    `ถ้าบทความไม่ได้ตอบคำถามนี้ ให้ตอบคำเดียวว่า ${NO_ANSWER}`,
    'ห้ามรับปากเรื่องราคา ค่าบริการ หรือกำหนดเวลา',
    input.customerName ? `ลูกค้า: ${input.customerName}` : null,
    equipment ? `อุปกรณ์ของลูกค้า:\n${equipment}` : null,
    `บทความ:\n\n${articles}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const history: ChatMessage[] = input.history
    .filter((m) => m.text)
    .slice(-HISTORY)
    .map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.text!,
    }));
  return [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: input.question },
  ];
}

/**
 * What the model wrote, checked: the articles it cites (only those it was
 * given), and the text without the labels. No citation, or NO_ANSWER, is
 * not an answer.
 */
export function readAnswer(
  text: string,
  articles: AnswerArticle[],
):
  | { answered: true; text: string; cited: AnswerArticle[] }
  | { answered: false } {
  const raw = text.trim();
  if (!raw || raw.includes(NO_ANSWER)) return { answered: false };
  const given = articles.slice(0, MAX_ARTICLES);
  const cited = new Set<number>();
  for (const match of raw.matchAll(/\[A(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= given.length) cited.add(n - 1);
  }
  if (!cited.size) return { answered: false };
  const clean = raw
    .replace(/\s*\[A\d+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return {
    answered: true,
    text: clean,
    cited: [...cited].sort((a, b) => a - b).map((i) => given[i]),
  };
}

/**
 * With `LLM_MODE=mock` there is no model to read the articles: answer with
 * the best article's summary (or its opening), citing it — so the flow can
 * be tried end to end without a gateway.
 */
export function extractiveAnswer(articles: AnswerArticle[]): string | null {
  const top = articles[0];
  if (!top) return null;
  const gist = (top.summary ?? top.body)
    .replace(/^#+\s.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return gist ? `${gist} [A1]` : null;
}

/** The answer as the customer reads it: the text, then the articles it used. */
export function withSources(
  text: string,
  cited: AnswerArticle[],
  link: (articleId: string) => string | null,
): string {
  const lines = cited.map((a) => {
    const url = link(a.id);
    return `• ${a.articleNo} ${a.title}${url ? `\n  ${url}` : ''}`;
  });
  return lines.length ? `${text}\n\nอ้างอิง:\n${lines.join('\n')}` : text;
}
