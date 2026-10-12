import { aiClosedPct, careResult, timelineSummary } from './care-results';

describe('CD-288 care results', () => {
  const base = {
    status: 'closed',
    caseRequestId: null,
    humanAt: null,
    aiAnswered: 1,
  };

  it('a case wins over a person, a person over AI', () => {
    expect(
      careResult({ ...base, caseRequestId: 'r', humanAt: new Date() }),
    ).toBe('case_opened');
    expect(careResult({ ...base, humanAt: new Date() })).toBe('handed_over');
    expect(careResult(base)).toBe('ai_resolved');
  });

  it('given back to AI still counts as handed over; open is live; no answer is apart', () => {
    expect(careResult({ ...base, status: 'open', humanAt: new Date() })).toBe(
      'handed_over',
    );
    expect(careResult({ ...base, status: 'open' })).toBe('live');
    expect(careResult({ ...base, aiAnswered: 0 })).toBe('no_answer');
  });

  it('the rate leaves out no_answer and live', () => {
    expect(
      aiClosedPct({ ai_resolved: 2, case_opened: 1, handed_over: 0 }),
    ).toBe(66.7);
    expect(
      aiClosedPct({ ai_resolved: 0, case_opened: 0, handed_over: 0 }),
    ).toBeNull();
  });

  it('the timeline carries no message text', () => {
    expect(
      timelineSummary({
        channel: 'line',
        messages: 6,
        result: 'case_opened',
        caseNo: 'SVC-12',
      }),
    ).toBe('บทสนทนา AI CARE ทาง LINE · 6 ข้อความ · เปิดเคส SVC-12');
    expect(
      timelineSummary({ channel: 'web', messages: 2, result: 'ai_resolved' }),
    ).toBe('บทสนทนา AI CARE ทาง เว็บแชต · 2 ข้อความ · AI ตอบจบเอง');
  });
});
