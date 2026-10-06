import {
  claimsIn,
  continues,
  emailKey,
  mergeClaims,
  onlyCustomer,
  phoneKey,
  platformField,
  stronger,
} from './care-rules';

describe('care rules', () => {
  it('keys Thai phone numbers on their last 9 digits', () => {
    expect(phoneKey('081-234-5678')).toBe('812345678');
    expect(phoneKey('+66 81 234 5678')).toBe('812345678');
    expect(phoneKey('02-123-4567')).toBe('021234567');
    expect(phoneKey('1234')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it('keys emails and refuses what is not one', () => {
    expect(emailKey(' Somchai@Example.CO.TH ')).toBe('somchai@example.co.th');
    expect(emailKey('not an email')).toBeNull();
  });

  it('finds what a sender typed', () => {
    expect(
      claimsIn(
        'เครื่องเสียครับ เบอร์ 081-234-5678 อีเมล a.b@corp.co.th รหัสลูกค้า cus-osdd-t89',
      ),
    ).toEqual({
      phones: ['812345678'],
      emails: ['a.b@corp.co.th'],
      customerCodes: ['CUS-OSDD-T89'],
    });
    expect(claimsIn('สวัสดีครับ')).toEqual({
      phones: [],
      emails: [],
      customerCodes: [],
    });
    expect(
      mergeClaims({ phones: ['1'] }, { phones: ['1', '2'], emails: ['e'] }),
    ).toEqual({ phones: ['1', '2'], emails: ['e'], customerCodes: [] });
  });

  it('verifies only from the identity the platform gives', () => {
    expect(platformField('line')).toBe('lineId');
    expect(platformField('email')).toBe('email');
    expect(platformField('callcenter')).toBe('phone');
    expect(platformField('facebook')).toBeNull();
    expect(platformField('web')).toBeNull();
  });

  it('matches only when one customer is meant', () => {
    expect(
      onlyCustomer([
        { customerId: 'a', id: '1' },
        { customerId: 'a', id: '2' },
      ]),
    ).toEqual({ customerId: 'a', id: '1' });
    expect(onlyCustomer([{ customerId: 'a' }, { customerId: 'b' }])).toBeNull();
    expect(onlyCustomer([])).toBeNull();
  });

  it('ends a conversation AI is handling after the idle hours only', () => {
    const at = new Date('2026-10-06T12:00:00Z');
    const ago = (h: number) => new Date(at.getTime() - h * 3600_000);
    expect(continues({ status: 'open', lastMessageAt: ago(23) }, at, 24)).toBe(
      true,
    );
    expect(continues({ status: 'open', lastMessageAt: ago(25) }, at, 24)).toBe(
      false,
    );
    expect(
      continues({ status: 'waiting_human', lastMessageAt: ago(100) }, at, 24),
    ).toBe(true);
    expect(continues({ status: 'closed', lastMessageAt: ago(1) }, at, 24)).toBe(
      false,
    );
  });

  it('never lowers identification', () => {
    expect(stronger('unknown', 'claimed')).toBe(true);
    expect(stronger('claimed', 'verified')).toBe(true);
    expect(stronger('verified', 'claimed')).toBe(false);
    expect(stronger('claimed', 'claimed')).toBe(false);
  });
});
