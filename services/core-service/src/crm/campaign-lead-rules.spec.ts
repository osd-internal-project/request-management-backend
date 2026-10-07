import { adLead, emailKey, phoneKey, samePerson } from './campaign-lead-rules';

describe('CD-269 campaign lead rules', () => {
  it('one phone written three ways is one phone', () => {
    expect(phoneKey('081-234-5678')).toBe('812345678');
    expect(phoneKey('+66 81 234 5678')).toBe('812345678');
    expect(phoneKey('0812345678')).toBe('812345678');
    expect(phoneKey('1234')).toBeNull();
    expect(emailKey(' Somchai@Example.com ')).toBe('somchai@example.com');
    expect(emailKey('not-an-email')).toBeNull();
  });

  it('the same person by e-mail or by phone', () => {
    const wanted = { email: 'a@x.co', phone: '812345678' };
    expect(samePerson(wanted, { email: 'A@X.CO', phone: null })).toBe(true);
    expect(samePerson(wanted, { email: null, phone: '081 234 5678' })).toBe(
      true,
    );
    expect(samePerson(wanted, { email: 'b@x.co', phone: '0899999999' })).toBe(
      false,
    );
    expect(
      samePerson({ email: null, phone: null }, { email: null, phone: null }),
    ).toBe(false);
  });

  it('reads a Facebook lead: company first, the person as contact, extras as a note', () => {
    expect(
      adLead('facebook', {
        form_id: 'fb-form-1',
        field_data: [
          { name: 'full_name', values: ['สมชาย ใจดี'] },
          { name: 'company_name', values: ['บจก. ตัวอย่าง'] },
          { name: 'phone_number', values: ['+66812345678'] },
          { name: 'budget', values: ['500k'] },
        ],
      }),
    ).toEqual({
      formId: 'fb-form-1',
      name: 'บจก. ตัวอย่าง',
      contactName: 'สมชาย ใจดี',
      phone: '+66812345678',
      email: null,
      note: 'budget: 500k',
    });
  });

  it('reads a TikTok lead; no contact at all is not a lead', () => {
    expect(
      adLead('tiktok', {
        form_id: 'tt-1',
        user_info: [
          { field_name: 'name', value: 'วิภา' },
          { field_name: 'email', value: 'wipa@example.com' },
        ],
      }),
    ).toMatchObject({
      formId: 'tt-1',
      name: 'วิภา',
      email: 'wipa@example.com',
    });
    expect(
      adLead('tiktok', {
        form_id: 'tt-1',
        user_info: [{ field_name: 'name', value: 'วิภา' }],
      }),
    ).toBeNull();
    expect(adLead('facebook', { field_data: [] })).toBeNull();
  });
});
