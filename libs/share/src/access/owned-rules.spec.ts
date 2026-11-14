import { customerAccessSubject, visibleCustomersWhere } from './customer-rules';
import { ownedBranches, visibleOwnedWhere } from './owned-rules';
import { salesAccessSubject, visibleSalesWhere } from './sales-rules';

const me = {
  userId: 'me',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  scopedUnitIds: [],
};

describe('P3 owned rows — every way in, one rule', () => {
  it('S2 own rows only, when nothing else applies', () => {
    expect(ownedBranches(me, { users: ['ownerUserId'], unit: 'ownerOrgUnitId' })).toEqual([
      { ownerUserId: 'me' },
    ]);
  });

  it('S4/S5/S6 led, role level and granted units all reach the unit column', () => {
    const subject = {
      ...me,
      ledUnitIds: ['led'],
      levelUnitIds: ['level'],
      scopedUnitIds: ['granted'],
    };
    expect(ownedBranches(subject, { users: ['ownerUserId'], unit: 'ownerOrgUnitId' })).toEqual([
      { ownerUserId: 'me' },
      { ownerOrgUnitId: { in: ['led', 'level', 'granted'] } },
    ]);
  });

  it('S7 a person granted by name counts as an owner', () => {
    expect(
      ownedBranches({ ...me, scopedUserIds: ['colleague'] }, { users: ['ownerUserId'] }),
    ).toEqual([{ ownerUserId: { in: ['me', 'colleague'] } }]);
  });

  it('Q10 no unit column: the owner’s current unit places the row', () => {
    expect(
      ownedBranches({ ...me, ledUnitIds: ['sales'] }, { users: ['managerUserId'], ownerRelation: 'manager' }),
    ).toEqual([{ managerUserId: 'me' }, { manager: { orgUnitId: { in: ['sales'] } } }]);
  });

  it('S1/S8 company pinned always; .read.all is the whole company', () => {
    expect(visibleOwnedWhere(me, { users: ['ownerUserId'] }, true)).toEqual({ companyId: 'osd' });
    expect(visibleOwnedWhere(me, { users: ['ownerUserId'] }, false)).toEqual({
      companyId: 'osd',
      OR: [{ ownerUserId: 'me' }],
    });
  });
});

describe('Q4 CRM now counts role level and per-person grants (it ignored both)', () => {
  const principal = {
    ...me,
    levelUnitIds: ['sales-dept'],
    scopedUserIds: ['colleague'],
    permissions: [],
  };

  it('deals', () => {
    expect(visibleSalesWhere(salesAccessSubject(principal))).toEqual({
      companyId: 'osd',
      OR: [
        { ownerUserId: { in: ['me', 'colleague'] } },
        { createdBy: { in: ['me', 'colleague'] } },
        { ownerOrgUnitId: { in: ['sales-dept'] } },
      ],
    });
  });

  it('customers', () => {
    expect(visibleCustomersWhere(customerAccessSubject(principal))).toEqual({
      companyId: 'osd',
      OR: [
        { accountOwnerUserId: { in: ['me', 'colleague'] } },
        { createdBy: { in: ['me', 'colleague'] } },
        { ownerOrgUnitId: { in: ['sales-dept'] } },
      ],
    });
  });
});
