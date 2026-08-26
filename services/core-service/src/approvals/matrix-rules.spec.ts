import { MatrixTier } from './approval-chain';
import { assertValidTiers } from './matrix-rules';

const VALID: MatrixTier[] = [
  { upto: '100000.00', chain: ['team_lead'] },
  { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
  { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
];

/** The ladder from §8.1, which is what the seed publishes. */
describe('APV-01 matrix validation', () => {
  it('accepts the standard three-tier ladder', () => {
    expect(() => assertValidTiers(VALID)).not.toThrow();
  });

  it('accepts a single open-ended tier', () => {
    expect(() =>
      assertValidTiers([{ upto: null, chain: ['team_lead'] }]),
    ).not.toThrow();
  });

  it('rejects an empty ladder — nothing could be approved', () => {
    expect(() => assertValidTiers([])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  /**
   * `selectTier` takes the *first* tier the amount fits, so an out-of-order
   * ladder makes later tiers unreachable without failing anywhere visible.
   */
  it('rejects descending ceilings', () => {
    expect(() =>
      assertValidTiers([
        { upto: '1000000.00', chain: ['team_lead'] },
        { upto: '100000.00', chain: ['team_lead', 'cfo'] },
        { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects equal ceilings, which make a tier dead', () => {
    expect(() =>
      assertValidTiers([
        { upto: '100000.00', chain: ['team_lead'] },
        { upto: '100000.00', chain: ['team_lead', 'cfo'] },
        { upto: null, chain: ['team_lead', 'cfo', 'ceo'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  /** An amount above the highest ceiling would have nowhere to route. */
  it('rejects a ladder with no open-ended top tier', () => {
    expect(() =>
      assertValidTiers([
        { upto: '100000.00', chain: ['team_lead'] },
        { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects an open-ended tier that is not last', () => {
    expect(() =>
      assertValidTiers([
        { upto: null, chain: ['team_lead'] },
        { upto: '1000000.00', chain: ['team_lead', 'cfo'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects an unknown approver position', () => {
    expect(() =>
      assertValidTiers([
        { upto: null, chain: ['team_lead', 'chairman'] as never },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  /** §8.1: step 1 is the requester's team lead, on every request. */
  it('rejects a chain that does not start at team_lead', () => {
    expect(() =>
      assertValidTiers([{ upto: null, chain: ['cfo', 'ceo'] }]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects an empty chain', () => {
    expect(() => assertValidTiers([{ upto: null, chain: [] }])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it.each(['0', '-1', 'abc'])('rejects ceiling %s', (upto) => {
    expect(() =>
      assertValidTiers([
        { upto, chain: ['team_lead'] },
        { upto: null, chain: ['team_lead', 'cfo'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
