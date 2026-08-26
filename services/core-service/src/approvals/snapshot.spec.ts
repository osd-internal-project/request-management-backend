import { snapshotHash } from './snapshot';

/**
 * APV-05. The failure this guards against is quiet: a deal value edited after
 * approval silently carries the approval onto numbers the approver never saw.
 */
describe('APV-05 snapshot binding', () => {
  it('is stable for the same payload', () => {
    const payload = { deal_value: 500000, discount_pct: 12 };
    expect(snapshotHash(payload)).toBe(snapshotHash(payload));
  });

  /**
   * Key order carries no meaning and varies with serialisation, so it must not
   * void an approval — a spurious void is as damaging as a missed one, because
   * people stop trusting the mechanism.
   */
  it('ignores key order', () => {
    expect(snapshotHash({ a: 1, b: 2 })).toBe(snapshotHash({ b: 2, a: 1 }));
  });

  it('ignores undefined, which reads the same as absent', () => {
    expect(snapshotHash({ a: 1, b: undefined })).toBe(snapshotHash({ a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(snapshotHash({ deal_value: 500000 })).not.toBe(
      snapshotHash({ deal_value: 500001 }),
    );
  });

  it('changes when a field is added', () => {
    expect(snapshotHash({ a: 1 })).not.toBe(snapshotHash({ a: 1, b: 2 }));
  });

  it('changes when a field is removed', () => {
    expect(snapshotHash({ a: 1, b: 2 })).not.toBe(snapshotHash({ a: 1 }));
  });

  /** Order in an array usually means something, so it must count. */
  it('respects array order', () => {
    expect(snapshotHash({ items: [1, 2] })).not.toBe(
      snapshotHash({ items: [2, 1] }),
    );
  });

  it('distinguishes nested changes', () => {
    expect(snapshotHash({ a: { b: 1 } })).not.toBe(
      snapshotHash({ a: { b: 2 } }),
    );
  });

  /** A number and its string form are different data, and must not collide. */
  it('distinguishes 1 from "1"', () => {
    expect(snapshotHash({ a: 1 })).not.toBe(snapshotHash({ a: '1' }));
  });

  it('handles null and empty payloads', () => {
    expect(() => snapshotHash(null)).not.toThrow();
    expect(snapshotHash({})).toBe(snapshotHash({}));
    expect(snapshotHash({})).not.toBe(snapshotHash({ a: 1 }));
  });
});
