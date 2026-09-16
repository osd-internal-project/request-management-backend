-- HR fields the previous system held and this one did not (16 Sep 2026).
--
-- Source: `source/users_202609160951.csv`, an export of the old user table —
-- 102 rows, of which 73 match a `users` row by username.
--
-- All four are nullable with no default and no backfill, for the same reason
-- `position` was: 17 people in this database are not in that export at all,
-- and 29 rows in the export have no account here. A default would state a fact
-- about them that nobody checked.
--
-- Two of these deliberately carry no constraint:
--
--   * `employeeId` is not UNIQUE. The values happen to be distinct today, but
--     the format is not — 98 are `EMP-NNN`, the others are `Consult-005`,
--     `M-008` and a bare `888`. A unique index would be a promise about data
--     this system does not own.
--   * `extension` is not UNIQUE on purpose. 14 of the 75 known extensions are
--     shared by more than one person, because a team around one handset gives
--     out one number.
--
-- `startWork` is TIMESTAMP(3) rather than DATE even though every source value
-- is midnight: nothing else in this schema uses a bare date, and one exception
-- is how a column starts getting special-cased in every query that touches it.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "employeeId" TEXT,
  ADD COLUMN IF NOT EXISTS "extension"  TEXT,
  ADD COLUMN IF NOT EXISTS "startWork"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "phone"      TEXT;
