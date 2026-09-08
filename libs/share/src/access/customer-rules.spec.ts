import {
  customerAccessSubject,
  visibleCustomersWhere,
  type CustomerAccessSubject,
} from './customer-rules';
import type { Permission } from '../policy/permissions';

const OSD = 'company-osd';
const ME = 'user-me';

function subject(
  overrides: Partial<CustomerAccessSubject> = {},
): CustomerAccessSubject {
  return {
    userId: ME,
    activeCompanyId: OSD,
    ledUnitIds: [],
    scopedUnitIds: [],
    readsAllCustomers: false,
    ...overrides,
  };
}

describe('CM-08 visibleCustomersWhere', () => {
  it('pins companyId in every shape it returns (SCOPE-03)', () => {
    expect(visibleCustomersWhere(subject())).toMatchObject({ companyId: OSD });
    expect(
      visibleCustomersWhere(subject({ readsAllCustomers: true })),
    ).toMatchObject({ companyId: OSD });
    expect(
      visibleCustomersWhere(subject({ ledUnitIds: ['unit-1'] })),
    ).toMatchObject({ companyId: OSD });
  });

  it('crm.customer.read.all sees the whole company and nothing narrower', () => {
    expect(visibleCustomersWhere(subject({ readsAllCustomers: true }))).toEqual(
      { companyId: OSD },
    );
  });

  it('a plain employee sees own book and own drafts only', () => {
    expect(visibleCustomersWhere(subject())).toEqual({
      companyId: OSD,
      OR: [{ accountOwnerUserId: ME }, { createdBy: ME }],
    });
  });

  it('a head also reaches the books sitting in led and granted groups', () => {
    const where = visibleCustomersWhere(
      subject({ ledUnitIds: ['unit-1'], scopedUnitIds: ['unit-2'] }),
    );

    expect(where.OR).toContainEqual({
      ownerOrgUnitId: { in: ['unit-1', 'unit-2'] },
    });
  });

  it('leading no groups adds no unit branch — never an empty IN that widens', () => {
    const where = visibleCustomersWhere(subject());

    expect(JSON.stringify(where)).not.toContain('ownerOrgUnitId');
  });
});

describe('customerAccessSubject', () => {
  const principal = {
    userId: ME,
    activeCompanyId: OSD,
    ledUnitIds: ['unit-1'],
    scopedUnitIds: [],
    permissions: ['crm.customer.read'] as Permission[],
  };

  it('reads read.all off the permission list', () => {
    expect(customerAccessSubject(principal).readsAllCustomers).toBe(false);
    expect(
      customerAccessSubject({
        ...principal,
        permissions: ['crm.customer.read.all'] as Permission[],
      }).readsAllCustomers,
    ).toBe(true);
  });
});
