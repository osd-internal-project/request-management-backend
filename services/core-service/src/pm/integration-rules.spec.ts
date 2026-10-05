import { integrationProblems, integrationTestText } from './integration-rules';

describe('CD-219 integration rules', () => {
  const base = {
    name: 'ส่งใบแจ้งหนี้',
    targetSystem: 'SAP ของลูกค้า',
    direction: 'outbound',
    contactId: 'c1',
    contactName: '',
    contactEmail: '',
  };

  it('a point names both systems, a direction and a customer owner', () => {
    expect(integrationProblems(base)).toEqual([]);
    expect(
      integrationProblems({
        ...base,
        name: '',
        targetSystem: ' ',
        direction: 'sideways',
        contactId: null,
      }),
    ).toHaveLength(4);
    // a typed owner is enough
    expect(
      integrationProblems({
        ...base,
        contactId: null,
        contactName: 'คุณสมชาย',
        contactEmail: 'somchai@',
      }),
    ).toEqual(['อีเมลผู้รับผิดชอบไม่ถูกต้อง']);
  });

  it('its test reads as the connection it proves', () => {
    expect(integrationTestText({ seq: 2, ...base, direction: 'both' })).toBe(
      'I-2 ทดสอบการเชื่อมต่อ ส่งใบแจ้งหนี้ ⇄ SAP ของลูกค้า',
    );
  });
});
