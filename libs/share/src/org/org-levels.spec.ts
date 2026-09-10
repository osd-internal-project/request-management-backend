import {
  canHoldMembers,
  childKindOf,
  isValidChildOf,
  MEMBER_LEVELS,
  ORG_UNIT_LEVELS,
  orgLevelIndex,
  parentKindOf,
} from './org-levels';

describe('org levels', () => {
  it('orders the chart widest first', () => {
    expect([...ORG_UNIT_LEVELS]).toEqual([
      'COMPANY',
      'DIVISION',
      'DEPARTMENT',
      'TEAM',
      'POSITION',
    ]);
  });

  /*
    The enum declares TEAM last, so a ranking taken from `Object.values` would
    put ทีม below ตำแหน่ง. This is the test that fails if anyone reintroduces
    that shortcut.
  */
  it('ranks ทีม above ตำแหน่ง, unlike the enum declaration order', () => {
    expect(orgLevelIndex('TEAM')).toBeLessThan(orgLevelIndex('POSITION'));
    expect(orgLevelIndex('COMPANY')).toBe(0);
  });

  it('pairs each level with the one directly above and below it', () => {
    expect(parentKindOf('COMPANY')).toBeNull();
    expect(parentKindOf('DEPARTMENT')).toBe('DIVISION');
    expect(childKindOf('DEPARTMENT')).toBe('TEAM');
    expect(childKindOf('POSITION')).toBeNull();
  });

  it('accepts only the adjacent level as a parent', () => {
    expect(isValidChildOf('COMPANY', null)).toBe(true);
    expect(isValidChildOf('DIVISION', 'COMPANY')).toBe(true);
    expect(isValidChildOf('POSITION', 'TEAM')).toBe(true);
  });

  it('refuses a skipped level and a rootless company', () => {
    expect(isValidChildOf('DEPARTMENT', 'COMPANY')).toBe(false);
    expect(isValidChildOf('POSITION', 'DEPARTMENT')).toBe(false);
    expect(isValidChildOf('COMPANY', 'COMPANY')).toBe(false);
    expect(isValidChildOf('DIVISION', null)).toBe(false);
  });

  it('lets people sit at แผนก and below, nowhere above it', () => {
    expect(canHoldMembers('DEPARTMENT')).toBe(true);
    expect(canHoldMembers('TEAM')).toBe(true);
    expect(canHoldMembers('POSITION')).toBe(true);
    expect(canHoldMembers('DIVISION')).toBe(false);
    expect(canHoldMembers('COMPANY')).toBe(false);
  });

  it('lists exactly the member-holding levels', () => {
    expect([...MEMBER_LEVELS]).toEqual(['DEPARTMENT', 'TEAM', 'POSITION']);
    expect(MEMBER_LEVELS.every(canHoldMembers)).toBe(true);
  });
});
