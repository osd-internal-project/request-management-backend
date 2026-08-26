import { createHash } from 'node:crypto';

/**
 * APV-05 — the fingerprint a decision is bound to.
 *
 * An approval means "I approve *these numbers*". Without binding the decision
 * to the data, editing a deal value after approval silently carries the
 * approval onto figures the approver never saw — which is the single most
 * damaging failure this engine can have, because it looks like nothing went
 * wrong.
 *
 * Keys are sorted so that key order, which carries no meaning, cannot change
 * the hash and void an approval spuriously. Nested objects recurse; arrays
 * keep their order, because in a payload it usually means something.
 */
export function snapshotHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Undefined and absent are the same thing to a reader, so treat them the
      // same here too — otherwise a serialisation quirk voids an approval.
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}
