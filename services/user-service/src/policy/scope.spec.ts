import {
  buildScopeWhere,
  ScopeColumns,
  ScopeSubject,
} from '@request-management/share';

const COLUMNS: ScopeColumns = {
  owner: 'requesterId',
  orgUnit: 'requesterOrgUnitId',
  company: 'companyId',
};

const SUBJECT: ScopeSubject = {
  userId: 'u_sales',
  activeCompanyId: 'c_osd',
  teamOrgUnitIds: ['ou_team', 'ou_sub'],
  departmentOrgUnitIds: ['ou_dept', 'ou_team', 'ou_sub'],
};

describe('§6 data scope', () => {
  describe('SCOPE-02: one filter for every level', () => {
    it('own — only rows the caller raised', () => {
      expect(buildScopeWhere('own', COLUMNS, SUBJECT)).toEqual({
        companyId: 'c_osd',
        requesterId: 'u_sales',
      });
    });

    it('team — the caller’s unit and everything beneath it', () => {
      expect(buildScopeWhere('team', COLUMNS, SUBJECT)).toEqual({
        companyId: 'c_osd',
        requesterOrgUnitId: { in: ['ou_team', 'ou_sub'] },
      });
    });

    it('department — the whole department subtree', () => {
      expect(buildScopeWhere('department', COLUMNS, SUBJECT)).toEqual({
        companyId: 'c_osd',
        requesterOrgUnitId: { in: ['ou_dept', 'ou_team', 'ou_sub'] },
      });
    });

    it('company — everything in the active company, nothing outside it', () => {
      expect(buildScopeWhere('company', COLUMNS, SUBJECT)).toEqual({
        companyId: 'c_osd',
      });
    });
  });

  describe('SCOPE-03: the company boundary is absolute', () => {
    it('pins companyId at every level except all', () => {
      for (const scope of ['own', 'team', 'department', 'company'] as const) {
        expect(buildScopeWhere(scope, COLUMNS, SUBJECT)).toHaveProperty(
          'companyId',
          'c_osd',
        );
      }
    });

    it('only `all` crosses companies — reserved for auditors', () => {
      expect(buildScopeWhere('all', COLUMNS, SUBJECT)).toEqual({});
    });

    it('an unassigned user matches nothing at team level, not everything', () => {
      const unassigned: ScopeSubject = {
        ...SUBJECT,
        teamOrgUnitIds: [],
        departmentOrgUnitIds: [],
      };

      expect(buildScopeWhere('team', COLUMNS, unassigned)).toEqual({
        companyId: 'c_osd',
        requesterOrgUnitId: { in: [] },
      });
    });
  });

  describe('SCOPE-06: approvers in the chain see the request anyway', () => {
    it('ORs the relatedness predicate onto the scope clause', () => {
      const where = buildScopeWhere('own', COLUMNS, SUBJECT, {
        approvalSteps: { some: { approverUserId: 'u_sales' } },
      });

      expect(where).toHaveProperty('OR');
      expect((where.OR as unknown[])[0]).toEqual({
        companyId: 'c_osd',
        requesterId: 'u_sales',
      });
    });

    it('does not widen `all`, which already sees everything', () => {
      expect(
        buildScopeWhere('all', COLUMNS, SUBJECT, { anything: true }),
      ).toEqual({});
    });
  });
});
