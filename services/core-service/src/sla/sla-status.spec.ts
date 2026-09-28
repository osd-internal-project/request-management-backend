import { readFileSync } from 'fs';
import { join } from 'path';
import { SLA_STATUS_SQL, slaStatusOf } from './sla-status';

const NOW = new Date('2026-09-28T03:00:00Z');
const PAST = new Date(NOW.getTime() - 3_600_000);
const FUTURE = new Date(NOW.getTime() + 3_600_000);

describe('CD-50 slaStatusOf — the one definition of คำขอค้างเกินกำหนด', () => {
  it.each([
    ['met', FUTURE, null, 'on_time'],
    ['breached', PAST, PAST, 'late'],
    ['cancelled', PAST, null, 'cancelled'],
    ['running', PAST, null, 'overdue'],
    ['running', FUTURE, null, 'on_track'],
    // paused after the sweep flagged it: still owed, still late
    ['paused', FUTURE, PAST, 'overdue'],
    // a paused clock's dueAt is stale (it moves on resume) — not late by itself
    ['paused', PAST, null, 'on_track'],
  ] as const)(
    '%s due %s breached %s → %s',
    (state, dueAt, breachedAt, expected) => {
      expect(slaStatusOf({ state, dueAt, breachedAt }, NOW)).toBe(expected);
    },
  );

  it('CD-50: Metabase reporting.sla_clocks computes sla_status with exactly this SQL', () => {
    const file = readFileSync(
      join(__dirname, '../../../../infra/metabase/reporting.sql'),
      'utf8',
    );
    const between =
      /-- sla_status BEGIN\n([\s\S]*?)\n\s*-- sla_status END/.exec(file);
    const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    expect(between).not.toBeNull();
    expect(squash(between![1])).toBe(squash(SLA_STATUS_SQL));
  });
});
