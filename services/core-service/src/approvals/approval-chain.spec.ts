import { AppError } from '@request-management/share';
import {
  ceilingIntroducing,
  assertStepOneResolvable,
  MatrixTier,
  resolveChain,
  selectTier,
} from './approval-chain';

/** The §8.1 standard ladder with the spec's illustrative ceilings. */
const TIERS: MatrixTier[] = [
  { upto: '100000.00', chain: ['team_lead'] },
  { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
  { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
];

const HOLDERS = { cfo: 'u_cfo', ceo: 'u_ceo' } as const;

describe('§8.1 approval chain', () => {
  describe('APV-01: tier selection by amount', () => {
    it('stops at the team lead below T1', () => {
      expect(selectTier(TIERS, '80000.00').chain).toEqual(['team_lead']);
    });

    it('adds the CFO between T1 and T2 — the spec’s 800,000 example', () => {
      expect(selectTier(TIERS, '800000.00').chain).toEqual([
        'team_lead',
        'cfo',
      ]);
    });

    it('treats the ceiling as inclusive', () => {
      expect(selectTier(TIERS, '100000.00').chain).toEqual(['team_lead']);
    });

    it('reaches the CEO above T2', () => {
      expect(selectTier(TIERS, '2500000.00').chain).toEqual([
        'team_lead',
        'cfo',
        'ceo',
      ]);
    });

    it('uses step 1 only when there is no amount (e.g. lead handover)', () => {
      expect(selectTier(TIERS, null).chain).toEqual(['team_lead']);
    });

    it('reports APV_MATRIX_NOT_FOUND when nothing is configured', () => {
      expect(() => selectTier([], '1000.00')).toThrow(AppError);
      expect(() => selectTier([], '1000.00')).toThrow(
        expect.objectContaining({ code: 'APV_MATRIX_NOT_FOUND' }),
      );
    });
  });

  describe('APV-02: positions resolve to people, and nobody approves their own', () => {
    it('resolves the standard two-step chain', () => {
      const chain = resolveChain({
        chain: ['team_lead', 'cfo'],
        requesterId: 'u_sales',
        requesterSupervisorId: 'u_lead',
        roleHolders: HOLDERS,
        supervisorOf: () => null,
      });

      expect(chain).toEqual([
        { position: 'team_lead', userId: 'u_lead' },
        { position: 'cfo', userId: 'u_cfo' },
      ]);
    });

    it('starts at the lead’s own supervisor when the lead submits', () => {
      const chain = resolveChain({
        chain: ['team_lead', 'cfo'],
        requesterId: 'u_lead',
        requesterSupervisorId: 'u_lead',
        roleHolders: HOLDERS,
        supervisorOf: (id) => (id === 'u_lead' ? 'u_director' : null),
      });

      expect(chain[0]).toEqual({ position: 'team_lead', userId: 'u_director' });
    });

    it('skips the CFO step entirely when the CFO submits', () => {
      const chain = resolveChain({
        chain: ['team_lead', 'cfo', 'ceo'],
        requesterId: 'u_cfo',
        requesterSupervisorId: 'u_lead',
        roleHolders: HOLDERS,
        supervisorOf: () => null,
      });

      expect(chain.map((step) => step.position)).toEqual(['team_lead', 'ceo']);
    });
  });

  describe('§8.1: a requester with no supervisor cannot submit', () => {
    it('reports ORG_SUPERVISOR_MISSING so the UI can point at the admin', () => {
      const chain = resolveChain({
        chain: ['team_lead'],
        requesterId: 'u_new',
        requesterSupervisorId: null,
        roleHolders: HOLDERS,
        supervisorOf: () => null,
      });

      expect(() => assertStepOneResolvable(chain)).toThrow(
        expect.objectContaining({ code: 'ORG_SUPERVISOR_MISSING' }),
      );
    });

    it('passes once a supervisor exists', () => {
      const chain = resolveChain({
        chain: ['team_lead'],
        requesterId: 'u_sales',
        requesterSupervisorId: 'u_lead',
        roleHolders: HOLDERS,
        supervisorOf: () => null,
      });

      expect(() => assertStepOneResolvable(chain)).not.toThrow();
    });
  });
});

describe('ceilingIntroducing (APV-02, §16 หน้าที่ 3)', () => {
  const ladder = [
    { upto: '100000.00', chain: ['team_lead'] },
    { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
    { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
  ] as const;

  it('reports the amount a request must exceed for CFO to join', () => {
    expect(ceilingIntroducing(ladder, 'cfo')).toBe('100000.00');
  });

  it('reports the amount a request must exceed for CEO to join', () => {
    expect(ceilingIntroducing(ladder, 'ceo')).toBe('1000000.00');
  });

  it('returns null for a position present from the lowest tier', () => {
    // team_lead is in every tier: there is no threshold to explain.
    expect(ceilingIntroducing(ladder, 'team_lead')).toBeNull();
  });

  it('returns null for a position this ladder never uses', () => {
    const flat = [{ upto: null, chain: ['team_lead'] }] as const;
    expect(ceilingIntroducing(flat, 'ceo')).toBeNull();
  });
});
