import { evidenceMove, evidenceNote, evidenceOf } from './evidence-rules';

describe('CD-218 task evidence', () => {
  it('a task with no evidence linked is left to the people', () => {
    expect(evidenceMove('open', { installs: [], tests: [] })).toBeNull();
  });

  it('closes when every point is installed and every test passed or waived', () => {
    const evidence = {
      installs: [{ installed: true }],
      tests: [{ state: 'passed' }, { state: 'waived' }],
    };
    expect(evidenceOf(evidence)).toEqual({
      linked: 3,
      missing: 0,
      complete: true,
    });
    expect(evidenceMove('in_progress', evidence)).toBe('done');
    expect(evidenceMove('done', evidence)).toBeNull();
    expect(evidenceNote('done', evidence)).toBe(
      'ปิดอัตโนมัติ — หลักฐานครบ 3 รายการ (จุดติดตั้ง 1 · ข้อทดสอบ 2)',
    );
  });

  it('reopens a done task when its evidence stops holding; never a cancelled one', () => {
    const evidence = {
      installs: [{ installed: true }],
      tests: [{ state: 'failed' }],
    };
    expect(evidenceMove('done', evidence)).toBe('in_progress');
    expect(evidenceMove('open', evidence)).toBeNull();
    expect(
      evidenceMove('cancelled', { installs: [{ installed: true }], tests: [] }),
    ).toBeNull();
    expect(evidenceNote('in_progress', evidence)).toBe(
      'เปิดใหม่อัตโนมัติ — หลักฐานยังไม่ครบ 1 จาก 2 รายการ',
    );
  });
});
