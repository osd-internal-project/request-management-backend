import {
  salesAccessSubject,
  visibleLeadsWhere,
  visibleSalesWhere,
  type SalesAccessSubject,
} from './sales-rules';
import type { Permission } from '../policy/permissions';

const OSD = 'company-osd';
const ME = 'user-me';

function subject(
  overrides: Partial<SalesAccessSubject> = {},
): SalesAccessSubject {
  return {
    userId: ME,
    activeCompanyId: OSD,
    ledUnitIds: [],
    scopedUnitIds: [],
    readsAllSales: false,
    ...overrides,
  };
}

describe('SCOPE-02 visibleSalesWhere', () => {
  it('pins companyId in every shape it returns (SCOPE-03)', () => {
    expect(visibleSalesWhere(subject())).toMatchObject({ companyId: OSD });
    expect(visibleSalesWhere(subject({ readsAllSales: true }))).toMatchObject({
      companyId: OSD,
    });
    expect(
      visibleSalesWhere(subject({ ledUnitIds: ['unit-1'] })),
    ).toMatchObject({ companyId: OSD });
  });

  it('crm.sales.read.all sees the whole company and nothing narrower', () => {
    expect(visibleSalesWhere(subject({ readsAllSales: true }))).toEqual({
      companyId: OSD,
    });
  });

  it('a plain seller sees own rows and own drafts only', () => {
    expect(visibleSalesWhere(subject())).toEqual({
      companyId: OSD,
      OR: [{ ownerUserId: ME }, { createdBy: ME }],
    });
  });

  // คอลัมน์ ownerUserId เป็น NOT NULL บน opportunities/quotations/sale_orders —
  // Prisma reject ทั้ง query ถ้ากิ่งนี้หลุดกลับเข้ามา ไม่ใช่แค่ไม่แมตช์.
  it('never asks for ownerUserId IS NULL', () => {
    expect(visibleSalesWhere(subject()).OR).not.toContainEqual({
      ownerUserId: null,
    });
    expect(
      visibleSalesWhere(subject({ ledUnitIds: ['unit-1'] })).OR,
    ).not.toContainEqual({ ownerUserId: null });
  });

  it('a head also reaches the rows sitting in led and granted groups', () => {
    const where = visibleSalesWhere(
      subject({ ledUnitIds: ['unit-1'], scopedUnitIds: ['unit-2'] }),
    );

    expect(where.OR).toContainEqual({
      ownerOrgUnitId: { in: ['unit-1', 'unit-2'] },
    });
  });

  it('leading no groups adds no unit branch — never an empty IN that widens', () => {
    expect(JSON.stringify(visibleSalesWhere(subject()))).not.toContain(
      'ownerOrgUnitId',
    );
  });
});

describe('SCOPE-02 visibleLeadsWhere', () => {
  it('adds the กองกลาง branch on top of the sales branches', () => {
    expect(visibleLeadsWhere(subject())).toEqual({
      companyId: OSD,
      OR: [{ ownerUserId: ME }, { createdBy: ME }, { ownerUserId: null }],
    });
  });

  it('keeps the unit branch and still offers the unowned pool', () => {
    const where = visibleLeadsWhere(subject({ ledUnitIds: ['unit-1'] }));

    expect(where.OR).toContainEqual({ ownerOrgUnitId: { in: ['unit-1'] } });
    expect(where.OR).toContainEqual({ ownerUserId: null });
  });

  it('crm.sales.read.all needs no pool branch — the company is already visible', () => {
    expect(visibleLeadsWhere(subject({ readsAllSales: true }))).toEqual({
      companyId: OSD,
    });
  });

  it('a lead-reading machine (AI, workflow) sees the whole company, still pinned to it', () => {
    expect(visibleLeadsWhere(subject({ readsAllLeads: true }))).toEqual({
      companyId: OSD,
    });
  });

  it('readsAllLeads leaves opportunities to the person rules', () => {
    expect(visibleSalesWhere(subject({ readsAllLeads: true }))).toHaveProperty(
      'OR',
    );
  });
});

describe('salesAccessSubject', () => {
  const principal = {
    userId: ME,
    activeCompanyId: OSD,
    ledUnitIds: ['unit-1'],
    scopedUnitIds: [],
    permissions: ['crm.sales.read'] as Permission[],
  };

  it('reads read.all off the permission list', () => {
    expect(salesAccessSubject(principal).readsAllSales).toBe(false);
    expect(
      salesAccessSubject({
        ...principal,
        permissions: ['crm.sales.read.all'] as Permission[],
      }).readsAllSales,
    ).toBe(true);
  });

  it('integration.crm.lead.read → readsAllLeads; a person never holds it', () => {
    expect(salesAccessSubject(principal).readsAllLeads).toBe(false);
    expect(
      salesAccessSubject({
        ...principal,
        permissions: ['integration.crm.lead.read'] as Permission[],
      }).readsAllLeads,
    ).toBe(true);
  });
});
