import {
  allSigned,
  hashOtp,
  hashToken,
  layoutProblems,
  newOtp,
  newToken,
  newVerifyCode,
  placement,
  readSignatureImage,
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
