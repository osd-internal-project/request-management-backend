/**
 * CD-207 — the cost per manday in effect on a day, for a level × work type.
 * Pure; dates are YYYY-MM-DD strings.
 */

export interface RateRow {
  levelId: string;
  workTypeId: string;
  validFrom: string;
  validTo: string | null;
}

/** The rate whose range covers `day` (a later start wins a tie). */
export function rateOn<T extends RateRow>(
  rates: readonly T[],
  levelId: string,
  workTypeId: string,
  day: string,
): T | null {
  return (
    rates
      .filter(
        (rate) =>
          rate.levelId === levelId &&
          rate.workTypeId === workTypeId &&
          rate.validFrom <= day &&
          (!rate.validTo || rate.validTo >= day),
      )
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0] ?? null
  );
}

/** The day before a YYYY-MM-DD date — where a new rate closes the old one. */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** What a labour line shows: "SE-2 วิศวกรอาวุโส · ติดตั้ง". */
export function laborLabel(
  level: { code: string; name: string },
  workType: { name: string },
): string {
  return `${level.code} ${level.name} · ${workType.name}`;
}
