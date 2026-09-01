import { AppError } from '@request-management/share';
import { assertValidLevels } from './matrix-rules';

/** The field a refusal blamed, which is what the screen highlights. */
function fieldOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return (error as AppError).details?.[0]?.field ?? '';
  }

  throw new Error('expected the ladder to be refused');
}

describe('APV-01: a ladder is validated before it is published', () => {
  it('accepts a supervisor level', () => {
    expect(() =>
      assertValidLevels([{ type: 'supervisor', up: 1 }]),
    ).not.toThrow();
  });

  it('accepts an org level naming groups', () => {
    expect(() =>
      assertValidLevels([{ type: 'org', orgUnitIds: ['unit-fin'] }]),
    ).not.toThrow();
  });

  it('accepts an org level naming people inside those groups', () => {
    expect(() =>
      assertValidLevels([
        { type: 'org', orgUnitIds: ['unit-fin'], userIds: ['u1', 'u2'] },
      ]),
    ).not.toThrow();
  });

  it('accepts several levels in order', () => {
    expect(() =>
      assertValidLevels([
        { type: 'supervisor', up: 1 },
        { type: 'supervisor', up: 3 },
        { type: 'org', orgUnitIds: ['unit-exec'] },
      ]),
    ).not.toThrow();
  });
});

describe('APV-01: what a ladder may not be', () => {
  /*
    Publishing is the last moment a malformed ladder can be caught. After it
    the failure is a request that routes to nobody, which reads as an approval
    mystery rather than a configuration error.
  */
  it('refuses an empty ladder — nothing could ever be approved', () => {
    expect(fieldOf(() => assertValidLevels([]))).toBe('levels');
    expect(fieldOf(() => assertValidLevels(null))).toBe('levels');
  });

  it('refuses a level that is not one of the two shapes', () => {
    expect(fieldOf(() => assertValidLevels([{ type: 'cfo' }]))).toBe(
      'levels[0].type',
    );
  });

  it('refuses a supervisor level with no level number', () => {
    expect(fieldOf(() => assertValidLevels([{ type: 'supervisor' }]))).toBe(
      'levels[0].up',
    );
  });

  it.each([0, -1, 1.5, '1'])('refuses up = %p', (up) => {
    expect(fieldOf(() => assertValidLevels([{ type: 'supervisor', up }]))).toBe(
      'levels[0].up',
    );
  });

  /**
   * A ladder that names no group resolves to nobody on every request — a
   * ladder that cannot be climbed, which is worse than no ladder at all
   * because the type looks configured.
   */
  it('refuses an org level naming no group', () => {
    expect(
      fieldOf(() => assertValidLevels([{ type: 'org', orgUnitIds: [] }])),
    ).toBe('levels[0].orgUnitIds');
  });

  it('blames the level that is wrong, not the first one', () => {
    expect(
      fieldOf(() =>
        assertValidLevels([
          { type: 'supervisor', up: 1 },
          { type: 'org', orgUnitIds: [] },
        ]),
      ),
    ).toBe('levels[1].orgUnitIds');
  });

  it('refuses ids that are not strings', () => {
    expect(
      fieldOf(() => assertValidLevels([{ type: 'org', orgUnitIds: [42] }])),
    ).toBe('levels[0].orgUnitIds');

    expect(
      fieldOf(() =>
        assertValidLevels([
          { type: 'org', orgUnitIds: ['unit-fin'], userIds: [42] },
        ]),
      ),
    ).toBe('levels[0].userIds');
  });
});
