import {
  NO_ANSWER,
  answerPrompt,
  extractiveAnswer,
  readAnswer,
  withSources,
} from './care-answer-rules';

const article = (
  n: number,
  extra: Partial<{ summary: string; body: string }> = {},
) => ({
  id: `a${n}`,
  articleNo: `KB-000${n}`,
  title: `เรื่องที่ ${n}`,
  summary: extra.summary ?? null,
  body: extra.body ?? `เนื้อหา ${n}`,
});

describe('answerPrompt', () => {
  it('labels the articles, gives the equipment and the conversation', () => {
    const chat = answerPrompt({
      question: 'ตู้สาขาโทรออกไม่ได้',
      articles: [article(1), article(2)],
      history: [
        { direction: 'in', author: 'customer', text: 'สวัสดี' },
        { direction: 'out', author: 'ai', text: 'สวัสดีครับ' },
        { direction: 'in', author: 'customer', text: null },
      ],
      customerName: 'บริษัท ก',
      assets: [
        {
          name: 'IP-PBX',
          model: 'X100',
          coverage: { title: 'MA', endOn: '2026-12-31' },
        },
        { name: 'Router', model: null, coverage: null },
      ],
    });
    expect(chat[0].role).toBe('system');
    expect(chat[0].content).toContain('[A1] KB-0001 — เรื่องที่ 1');
    expect(chat[0].content).toContain('[A2] KB-0002');
    expect(chat[0].content).toContain(NO_ANSWER);
    expect(chat[0].content).toContain(
      'IP-PBX (X100): อยู่ในสิทธิ์บริการ MA ถึง 2026-12-31',
    );
    expect(chat[0].content).toContain('Router: ไม่มีสิทธิ์บริการที่มีผล');
    expect(chat.slice(1).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(chat[chat.length - 1].content).toBe('ตู้สาขาโทรออกไม่ได้');
  });
});

describe('readAnswer', () => {
  const given = [article(1), article(2)];

  it('keeps an answer that cites what it was given, without the labels', () => {
    expect(
      readAnswer('ลองรีสตาร์ทตู้ [A2] แล้วโทรใหม่ [A2][A1]', given),
    ).toEqual({
      answered: true,
      text: 'ลองรีสตาร์ทตู้ แล้วโทรใหม่',
      cited: [given[0], given[1]],
    });
  });

  it('refuses no citation, a made-up one, or NO_ANSWER', () => {
    expect(readAnswer('ลองรีสตาร์ทดู', given)).toEqual({ answered: false });
    expect(readAnswer('ตามบทความ [A7]', given)).toEqual({ answered: false });
    expect(readAnswer(`${NO_ANSWER}`, given)).toEqual({ answered: false });
    expect(readAnswer('', given)).toEqual({ answered: false });
  });
});

describe('extractiveAnswer', () => {
  it('answers from the best article in mock mode', () => {
    expect(extractiveAnswer([article(1, { summary: 'รีสตาร์ทตู้ก่อน' })])).toBe(
      'รีสตาร์ทตู้ก่อน [A1]',
    );
    expect(
      extractiveAnswer([article(1, { body: '## หัว\nขั้นที่ 1\nขั้นที่ 2' })]),
    ).toBe('ขั้นที่ 1 ขั้นที่ 2 [A1]');
    expect(extractiveAnswer([])).toBeNull();
  });
});

describe('withSources', () => {
  it('lists the articles used, with a link when there is one', () => {
    expect(
      withSources('ลองรีสตาร์ท', [article(1), article(2)], (id) =>
        id === 'a1' ? 'https://x/f/portal?article=a1' : null,
      ),
    ).toBe(
      'ลองรีสตาร์ท\n\nอ้างอิง:\n• KB-0001 เรื่องที่ 1\n  https://x/f/portal?article=a1\n• KB-0002 เรื่องที่ 2',
    );
    expect(withSources('ข้อความ', [], () => null)).toBe('ข้อความ');
  });
});
