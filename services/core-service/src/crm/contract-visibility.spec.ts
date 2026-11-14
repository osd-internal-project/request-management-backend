import type { Principal } from '@request-management/share';
import { contractVisibleWhere } from './contract-visibility';

function person(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    permissions: ['legal.contract.read'],
    ledUnitIds: ['sales'],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedUserIds: [],
    isServiceAccount: false,
    ...overrides,
  } as unknown as Principal;
}

const namedOnly = [
  { ownerUserId: 'me' },
  { createdBy: 'me' },
  { access: { some: { userId: 'me' } } },
];

describe('CD-161 + Q9 contract visibility', () => {
  it('legal.contract.read: ordinary contracts only through owner, author or unit; always in the company', () => {
    expect(contractVisibleWhere(person())).toEqual({
      companyId: 'osd',
      OR: [
        {
          confidential: false,
          OR: [
            { ownerUserId: 'me' },
            { createdBy: 'me' },
            { ownerOrgUnitId: { in: ['sales'] } },
          ],
        },
        ...namedOnly,
      ],
    });
  });

  it('legal.contract.read.all: every ordinary contract; confidential still named people only', () => {
    expect(
      contractVisibleWhere(
        person({ permissions: ['legal.contract.read', 'legal.contract.read.all'] as never }),
      ),
    ).toEqual({ companyId: 'osd', OR: [{ confidential: false }, ...namedOnly] });
  });

  it('a machine key keeps reading every ordinary contract of its company', () => {
    expect(contractVisibleWhere(person({ isServiceAccount: true }))).toEqual({
      companyId: 'osd',
      OR: [{ confidential: false }, ...namedOnly],
    });
  });

  it('legal.contract.manage: the whole company, pinned', () => {
    expect(
      contractVisibleWhere(person({ permissions: ['legal.contract.manage'] as never })),
    ).toEqual({ companyId: 'osd' });
  });
});
