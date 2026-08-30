-- The real OSD org chart has a level this schema did not (28 Aug 2026).
--
-- `14_LIST_STAFF` keeps `ฝ่าย` (division) and `แผนก` (department) in separate
-- columns; the first import read only the department column and hung all 29
-- units flat under the company root, which is not the organisation.
--
-- `DIVISION` sits between COMPANY and DEPARTMENT. Postgres appends the value
-- to the end of the type regardless of where it is written in the Prisma
-- schema — enum *order* here is documentation, not storage, and nothing in
-- this codebase compares OrgUnitKind values by ordinal.
ALTER TYPE "OrgUnitKind" ADD VALUE IF NOT EXISTS 'DIVISION';

-- Job title, from `14_LIST_STAFF` column E. Nullable: the staff register does
-- not have one for everybody, and an invented title is worse than none.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "position" TEXT;
