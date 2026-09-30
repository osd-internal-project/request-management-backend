import {
  allSigned,
  authorityFor,
  hashOtp,
  hashToken,
  layoutProblems,
  newOtp,
  newToken,
  newVerifyCode,
  openToken,
  placement,
  readSignatureImage,
  reminderDue,
  sealToken,
  turnOf,
  type LayoutField,
} from './esign-rules';

const field = (over: Partial<LayoutField> = {}): LayoutField => ({
  key: 'f1',
  label: 'ผู้ว่าจ้าง',
  page: 'last',
  position: 'bottom-left',
  order: 1,
  ...over,
});

describe('CD-165 signature layouts', () => {
  it('a layout names each party once, on a real page, without two fields in one spot', () => {
    expect(
      layoutProblems([
        field(),
        field({
          key: 'f2',
          label: 'ผู้รับจ้าง',
          position: 'bottom-right',
          order: 2,
        }),
      ]),
    ).toEqual([]);
    expect(layoutProblems([])).toEqual(['ต้องมีช่องลงนามอย่างน้อยหนึ่งช่อง']);
    expect(
      layoutProblems([
        field(),
        field({ key: 'f1', label: ' ', page: 0, order: 0 }),
      ]),
    ).toEqual([
      'ช่องที่ 2: ต้องระบุผู้ลงนาม',
      'ช่องที่ 2: รหัสช่องซ้ำ',
      'ช่องที่ 2: หน้าไม่ถูกต้อง',
      'ช่องที่ 2: ลำดับต้องเป็นจำนวนเต็มตั้งแต่ 1',
    ]);
    expect(
      layoutProblems([field(), field({ key: 'f2', label: 'พยาน' })]),
    ).toEqual(['ช่องที่ 2: ซ้อนกับช่องอื่นในตำแหน่งเดียวกัน']);
    // the signature page has room for everyone
    expect(
      layoutProblems([
        field({ page: 'appendix' }),
        field({ key: 'f2', label: 'พยาน', page: 'appendix' }),
      ]),
    ).toEqual([]);
  });

  it('places a field on its page and corner; a page past the end falls on the last', () => {
    const a4 = { width: 595, height: 842 };
    expect(placement(field(), 3, a4, 0)).toEqual({
      appendix: false,
      pageIndex: 2,
      x: 36,
      y: 36,
    });
    expect(
      placement(field({ page: 'first', position: 'top-right' }), 3, a4, 0),
    ).toMatchObject({ pageIndex: 0, x: 595 - 36 - 180, y: 842 - 36 - 70 });
    expect(placement(field({ page: 9 }), 3, a4, 0).pageIndex).toBe(2);
    const second = placement(field({ page: 'appendix' }), 3, a4, 1);
    expect(second).toMatchObject({ appendix: true, x: 36 + 180 + 60 });
  });
});

describe('CD-166/167 links and codes', () => {
  it("a link's secret is kept only as its hash; a code only as a keyed hash", () => {
    const { token, hash } = newToken();
    expect(token).toHaveLength(43);
    expect(hashToken(token)).toBe(hash);
    const { code, hash: otp } = newOtp('secret');
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(hashOtp(code, 'secret')).toBe(otp);
    expect(hashOtp(code, 'other')).not.toBe(otp);
    expect(newVerifyCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('CD-168 who signs when', () => {
  const signers = [
    { id: 'a', order: 1, status: 'signed' },
    { id: 'b', order: 2, status: 'pending' },
    { id: 'c', order: 2, status: 'pending' },
    { id: 'd', order: 3, status: 'pending' },
  ];
  it('in order: the next order signs together; later ones wait', () => {
    expect(turnOf(signers[1], signers, 'sequential').may).toBe(true);
    expect(turnOf(signers[2], signers, 'sequential').may).toBe(true);
    expect(turnOf(signers[3], signers, 'sequential')).toEqual({
      may: false,
      waitingFor: 2,
    });
    expect(turnOf(signers[3], signers, 'parallel').may).toBe(true);
    expect(allSigned(signers)).toBe(false);
    expect(allSigned([{ status: 'signed' }])).toBe(true);
    expect(allSigned([])).toBe(false);
  });

  it('a signature image is a PNG or JPEG data URL, and small', () => {
    const png = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    expect(readSignatureImage(png)?.mime).toBe('image/png');
    expect(readSignatureImage('data:image/gif;base64,AAAA')).toBeNull();
    expect(
      readSignatureImage(
        `data:image/png;base64,${Buffer.alloc(600_000).toString('base64')}`,
      ),
    ).toBeNull();
  });
});

describe('CD-172 signing authority', () => {
  const today = new Date('2026-09-30T00:00:00Z');
  const entry = (over: Record<string, unknown> = {}) => ({
    userId: 'u1',
    title: 'กรรมการผู้จัดการ',
    limitAmount: 1_000_000 as number | null,
    docTypes: [] as string[],
    validFrom: null as Date | null,
    validTo: null as Date | null,
    active: true,
    ...over,
  });

  it('within the limit, for the kind of document, in its period', () => {
    expect(authorityFor([entry()], 'u1', 'contract', 500_000, today)).toEqual({
      ok: true,
      title: 'กรรมการผู้จัดการ',
    });
    // an amount not known is covered by any entry; no limit covers any amount
    expect(authorityFor([entry()], 'u1', 'contract', null, today).ok).toBe(
      true,
    );
    expect(
      authorityFor([entry({ limitAmount: null })], 'u1', 'contract', 9e9, today)
        .ok,
    ).toBe(true);
  });

  it('says why not: not on the register, another kind, out of period, over the limit', () => {
    const not = (entries: ReturnType<typeof entry>[], amount = 500_000) =>
      authorityFor(entries, 'u1', 'contract', amount, today);
    expect(not([])).toMatchObject({ ok: false });
    expect(not([entry({ userId: 'u2' })]).ok).toBe(false);
    expect(not([entry({ active: false })]).ok).toBe(false);
    expect(not([entry({ docTypes: ['acceptance'] })]).ok).toBe(false);
    expect(not([entry({ validTo: new Date('2026-09-29T00:00:00Z') })]).ok).toBe(
      false,
    );
    expect(not([entry()], 2_000_000)).toEqual({
      ok: false,
      reason: 'วงเงินอำนาจลงนาม 1,000,000 บาท ไม่ถึงมูลค่าเอกสาร 2,000,000 บาท',
    });
  });
});

describe('CD-171 reminders', () => {
  it('the link survives encrypted and opens only with its key', () => {
    const sealed = sealToken('secret-link', 'k1');
    expect(openToken(sealed, 'k1')).toBe('secret-link');
    expect(openToken(sealed, 'k2')).toBeNull();
    expect(openToken('garbage', 'k1')).toBeNull();
  });

  it('every N days since last reached, at most M times', () => {
    const at = new Date('2026-09-30T00:00:00Z');
    const later = (days: number) => new Date(at.getTime() + days * 86_400_000);
    expect(reminderDue(at, 0, later(1), 2, 3)).toBe(false);
    expect(reminderDue(at, 0, later(2), 2, 3)).toBe(true);
    expect(reminderDue(at, 3, later(9), 2, 3)).toBe(false);
    expect(reminderDue(null, 0, later(9), 2, 3)).toBe(false);
  });
});
