import { DEFAULT_SEVERITY_WORDS } from './care-case-rules';
import {
  DEFAULT_ASK_WORDS,
  DEFAULT_DISPLEASED_WORDS,
  handoverNotice,
  handoverReason,
  remindDue,
  tooManyUnanswered,
} from './care-handover-rules';

const words = {
  ask: DEFAULT_ASK_WORDS,
  displeased: DEFAULT_DISPLEASED_WORDS,
  severity: DEFAULT_SEVERITY_WORDS,
};

describe('handoverReason', () => {
  it('a request for a person comes first, then severe, then displeasure', () => {
    expect(handoverReason('ขอคุยกับเจ้าหน้าที่หน่อยครับ', words)).toBe('asked');
    expect(handoverReason('Admin อยู่ไหม', words)).toBe('asked');
    expect(handoverReason('ระบบล่มทั้งบริษัท', words)).toBe('severe');
    expect(handoverReason('แย่มาก รอมาทั้งวัน', words)).toBe('displeased');
    expect(handoverReason('ทำไมยังไม่ได้!!!', words)).toBe('displeased');
    expect(handoverReason('ระบบล่มทั้งบริษัท ขอคุยกับคน', words)).toBe('asked');
  });

  it('an ordinary question stays with AI', () => {
    expect(handoverReason('ตู้สาขาโทรออกไม่ได้', words)).toBeNull();
    expect(handoverReason('', words)).toBeNull();
    expect(handoverReason(null, words)).toBeNull();
  });
});

describe('the rest', () => {
  it('counts unanswered questions against the limit (0 = never)', () => {
    expect(tooManyUnanswered(1, 2)).toBe(false);
    expect(tooManyUnanswered(2, 2)).toBe(true);
    expect(tooManyUnanswered(5, 0)).toBe(false);
  });

  it('reminds after the minutes, once told', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    expect(remindDue(new Date('2026-10-07T09:29:00Z'), now, 30)).toBe(true);
    expect(remindDue(new Date('2026-10-07T09:45:00Z'), now, 30)).toBe(false);
    expect(remindDue(null, now, 30)).toBe(false);
    expect(remindDue(new Date('2026-10-07T01:00:00Z'), now, 0)).toBe(false);
  });

  it('tells the customer who will answer and when', () => {
    expect(handoverNotice({ outOfHours: false, onCall: false })).toContain(
      'เจ้าหน้าที่จะตอบกลับในแชตนี้',
    );
    expect(handoverNotice({ outOfHours: true, onCall: true })).toContain(
      'เจ้าหน้าที่เวร',
    );
    expect(handoverNotice({ outOfHours: true, onCall: false })).toContain(
      'เวลาทำการถัดไป',
    );
  });
});
