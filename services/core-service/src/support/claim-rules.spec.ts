import {
  claimOverdue,
  issueReference,
  replaceProblems,
  stepProblems,
} from './claim-rules';

describe('CD-245 spares and claims rules', () => {
  it('moves a claim only forward, each step with what it needs', () => {
    expect(
      stepProblems('pending', {
        to: 'sent',
        sentOn: '2026-10-05',
        expectedOn: '2026-10-20',
      }),
    ).toEqual([]);
    expect(stepProblems('pending', { to: 'sent' })).toEqual([
      'ต้องระบุวันที่ส่งเคลม',
    ]);
    expect(
      stepProblems('pending', {
        to: 'sent',
        sentOn: '2026-10-05',
        expectedOn: '2026-10-01',
      }),
    ).toEqual(['วันที่คาดว่าจะได้คืนต้องไม่ก่อนวันส่ง']);
    expect(stepProblems('pending', { to: 'replaced' })[0]).toContain('ไม่ได้');
    expect(
      stepProblems('sent', { to: 'credited', resolvedOn: '2026-10-25' }),
    ).toEqual(['ต้องระบุยอดเครดิตที่ได้']);
    expect(
      stepProblems('sent', { to: 'rejected', resolvedOn: '2026-10-25' }),
    ).toEqual(['ต้องระบุเหตุผลที่คู่ค้าปฏิเสธ']);
    expect(
      stepProblems('sent', { to: 'replaced', resolvedOn: '2026-10-25' }),
    ).toEqual([]);
    expect(stepProblems('replaced', { to: 'cancelled' })).toHaveLength(1);
  });

  it('is late once sent and past the day it was expected back', () => {
    expect(
      claimOverdue({ status: 'sent', expectedOn: '2026-10-04' }, '2026-10-05'),
    ).toBe(true);
    expect(
      claimOverdue({ status: 'sent', expectedOn: '2026-10-05' }, '2026-10-05'),
    ).toBe(false);
    expect(
      claimOverdue(
        { status: 'replaced', expectedOn: '2026-10-01' },
        '2026-10-05',
      ),
    ).toBe(false);
    expect(
      claimOverdue({ status: 'sent', expectedOn: null }, '2026-10-05'),
    ).toBe(false);
  });

  it('references a goods issue in 11 characters', () => {
    expect(issueReference('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(
      'SV3FA85F645',
    );
  });

  it('needs a new serial, different, and why', () => {
    expect(
      replaceProblems({ oldSerial: 'A1', newSerial: 'B2', reason: 'เสีย' }),
    ).toEqual([]);
    expect(
      replaceProblems({ oldSerial: 'A1', newSerial: 'A1', reason: '' }),
    ).toEqual([
      'หมายเลขเครื่องใหม่ซ้ำกับเครื่องเดิม',
      'ต้องระบุเหตุผลที่เปลี่ยน',
    ]);
    expect(
      replaceProblems({ oldSerial: 'A1', newSerial: null, reason: 'x' }),
    ).toEqual(['ต้องระบุหมายเลขเครื่องใหม่']);
  });
});
