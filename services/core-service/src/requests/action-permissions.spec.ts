import { ACTIONS, ACTION_PERMISSIONS } from './available-actions';
import { PERMISSIONS } from '@request-management/share';

const CATALOG = new Set(Object.values(PERMISSIONS).flat() as string[]);

/**
 * The table the external dispatcher reads instead of a decorator it cannot
 * write. A verb missing from it would dispatch with nobody's permission
 * checked, which is the hole `ActingPolicyGuard` exists to close.
 */
describe('ACTION_PERMISSIONS covers the flow', () => {
  it('names a permission for every action in the table', () => {
    const missing = ACTIONS.map((spec) => spec.action).filter(
      (action) => !ACTION_PERMISSIONS[action],
    );

    expect(missing).toEqual([]);
  });

  it('names nothing the flow does not have', () => {
    const known = new Set(ACTIONS.map((spec) => spec.action));

    expect(
      Object.keys(ACTION_PERMISSIONS).filter((a) => !known.has(a as never)),
    ).toEqual([]);
  });

  it('only names permissions that exist in the catalog', () => {
    const unknown = Object.values(ACTION_PERMISSIONS).filter(
      (permission) => !CATALOG.has(permission),
    );

    expect(unknown).toEqual([]);
  });
});
