import { installBlockers } from './install-rules';

const ok = (key: string) => ({ key, label: key, ok: true, detail: null });

describe('CD-254 install gate', () => {
  it('ผ่านเมื่อรายการตรวจผ่านครบ และข้อของระบบผ่าน ไม่นับเอกสารส่งมอบ/การยืนยัน', () => {
    expect(
      installBlockers({
        checks: [
          ok('tests'),
          {
            key: 'delivery_docs',
            label: 'เอกสาร',
            ok: false,
            detail: 'ขาด ใบส่งของ',
          },
          {
            key: 'install_confirmed',
            label: 'ยืนยัน',
            ok: false,
            detail: null,
          },
        ],
        readiness: { total: 3, passed: 3, failed: 0, unchecked: 0 },
      }),
    ).toEqual([]);
  });

  it('ยังไม่เริ่มตรวจ / ยังไม่ผ่านครบ / ข้อระบบไม่ผ่าน', () => {
    expect(
      installBlockers({
        checks: [],
        readiness: { total: 0, passed: 0, failed: 0, unchecked: 0 },
      }),
    ).toEqual(['ทีมช่างยังไม่ได้เริ่มตรวจความพร้อมก่อนส่งมอบ']);
    expect(
      installBlockers({
        checks: [
          {
            key: 'tests',
            label: 'ทดสอบผ่านครบ',
            ok: false,
            detail: 'ผ่าน 3/5',
          },
        ],
        readiness: { total: 4, passed: 2, failed: 1, unchecked: 1 },
      }),
    ).toEqual([
      'รายการตรวจความพร้อมผ่าน 2/4 (ไม่ผ่าน 1)',
      'ทดสอบผ่านครบ: ผ่าน 3/5',
    ]);
  });
});
