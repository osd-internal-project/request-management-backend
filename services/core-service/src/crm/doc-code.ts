/** Bound on skipping codes already taken by another company. */
export const MAX_TAKEN_SKIPS = 1000;

/**
 * Document codes (CUS/OPP/SO/QT) are unique across ALL companies, but every
 * counter is per company — so the next number can already be held by another
 * company: one whose docPrefix used to be this one (OSDD was OSD, keeping
 * CUS-OSD-000001/2), or one sharing the prefix (docPrefix is not unique).
 * Keep drawing from the counter until a free code comes up rather than fail
 * the insert; a gap is fine, a collision is not.
 *
 * `next` must bump the counter inside the caller's transaction, so skipped
 * numbers are consumed only when the document itself commits.
 */
export async function firstFreeCode(
  counter: string,
  next: () => Promise<string>,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_TAKEN_SKIPS; attempt++) {
    const code = await next();
    if (!(await isTaken(code))) return code;
  }

  throw new Error(
    `${counter} is behind by more than ${MAX_TAKEN_SKIPS} taken codes`,
  );
}
