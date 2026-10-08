import {
  acceptsCase,
  caseDetail,
  caseNotice,
  caseSubject,
  severityOf,
  wordsFrom,
} from './care-case-rules';

describe('acceptsCase', () => {
  it('takes a short yes', () => {
    for (const yes of [
      'เปิดเรื่องเลยครับ',
      'ตกลง',
      'ok',
      'OK!',
      'ได้ครับ',
      'ใช่ค่ะ',
      'รบกวนด้วยนะคะ',
      'ช่วยเปิดให้หน่อย',
    ])
      expect([yes, acceptsCase(yes)]).toEqual([yes, true]);
  });

  it('refuses a no, a new question, or nothing', () => {
    for (const no of [
      'ไม่ต้องครับ',
      'ยังก่อน',
      'no thanks',
      'ได้ไหมครับถ้าเครื่องพิมพ์ยังเสียอยู่แบบนี้ทุกวันแล้วต้องทำอย่างไรต่อ',
      '',
      'สวัสดี',
      'ได้ไหม',
      'เปิดเรื่องได้มั้ย?',
    ])
      expect([no, acceptsCase(no)]).toEqual([no, false]);
    expect(acceptsCase(null)).toBe(false);
  });
});

describe('severityOf', () => {
  it('takes the most serious word', () => {
    expect(severityOf(['ตู้สาขาเสีย', 'ระบบล่มทั้งบริษัทเลย'])).toBe(
      'critical',
    );
    expect(severityOf(['โทรออกไม่ได้'])).toBe('high');
    expect(severityOf(['ขอสอบถามวิธีตั้งค่า'])).toBe('low');
    expect(severityOf(['เครื่องช้า', null])).toBe('medium');
  });

  it('reads word lists from the environment', () => {
    expect(wordsFrom(' a, B ,,', ['x'])).toEqual(['a', 'b']);
    expect(wordsFrom(undefined, ['x'])).toEqual(['x']);
    expect(severityOf(['พัง'], { critical: ['พัง'], high: [], low: [] })).toBe(
      'critical',
    );
  });
});

describe('the case text', () => {
  const messages = [
    { direction: 'in', author: 'customer', text: 'สวัสดีครับ' },
    { direction: 'out', author: 'ai', text: 'สวัสดี มีอะไรให้ช่วย' },
    { direction: 'in', author: 'customer', text: 'ตู้สาขาโทรออกไม่ได้' },
    { direction: 'in', author: 'customer', text: null },
  ];

  it('takes the subject from the first message that says something', () => {
    expect(caseSubject(messages)).toBe('ตู้สาขาโทรออกไม่ได้');
    expect(caseSubject([])).toBe('แจ้งผ่าน AI CARE');
    expect(
      caseSubject([
        {
          direction: 'in',
          author: 'customer',
          text: 'ก'.repeat(200) + ' ตู้สาขา',
        },
      ]),
    ).toHaveLength(120);
  });

  it('gives the team where it came from, the summary and the conversation', () => {
    const detail = caseDetail({
      channel: 'LINE',
      sender: 'คุณสมชาย',
      summary: 'ตู้โทรออกไม่ได้',
      messages,
    });
    expect(detail).toBe(
      'แจ้งผ่าน AI CARE · ช่องทาง LINE · ผู้ส่ง คุณสมชาย\n\nสรุป: ตู้โทรออกไม่ได้\n\nบทสนทนา:\nลูกค้า: สวัสดีครับ\nAI CARE: สวัสดี มีอะไรให้ช่วย\nลูกค้า: ตู้สาขาโทรออกไม่ได้',
    );
  });

  it('tells the customer the number and where to follow it', () => {
    expect(
      caseNotice({
        requestNo: 'SVC-0001',
        severity: 'high',
        statusLink: 'https://x/f/status/t',
      }),
    ).toBe(
      'เปิดเรื่องให้ทีมบริการแล้ว เลขที่ SVC-0001 (ความเร่งด่วน: สูง)\nทีมบริการจะติดต่อกลับโดยเร็ว\nติดตามสถานะได้ที่ https://x/f/status/t',
    );
    expect(
      caseNotice({ requestNo: null, severity: 'medium', statusLink: null }),
    ).toBe(
      'เปิดเรื่องให้ทีมบริการแล้ว (ความเร่งด่วน: ปานกลาง)\nทีมบริการจะติดต่อกลับโดยเร็ว',
    );
  });
});
