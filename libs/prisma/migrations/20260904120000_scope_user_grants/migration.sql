-- A scope grant may name a person on either end (4 ก.ย. 2569).
--
-- `org_unit_scopes` could only say "ฝ่ายขาย sees ฝ่ายการตลาด". The chart is not
-- the only shape authority takes: one designer covers one account manager's
-- work, and writing that as a group grant hands over both whole groups. Both
-- ends now accept either a group or a person.
--
-- The table keeps its name. Renaming it to `access_scopes` would be more
-- honest and is a migration of its own — this one has to be safe to run under
-- a rolling deploy, where the previous release is still writing rows.
ALTER TABLE "org_unit_scopes" ADD COLUMN "viewerUserId" TEXT;
ALTER TABLE "org_unit_scopes" ADD COLUMN "targetUserId" TEXT;

-- Existing rows are all group→group and already carry both values, so there is
-- nothing to backfill. Relaxing NOT NULL comes after the columns exist, so a
-- row can never be visible with neither end set.
ALTER TABLE "org_unit_scopes" ALTER COLUMN "viewerOrgUnitId" DROP NOT NULL;
ALTER TABLE "org_unit_scopes" ALTER COLUMN "targetOrgUnitId" DROP NOT NULL;

-- Exactly one end each. A row with neither reaches nobody; a row with both
-- would have to pick one silently, and the resolver would pick differently
-- from the screen that wrote it.
ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_one_viewer"
    CHECK (num_nonnulls("viewerOrgUnitId", "viewerUserId") = 1);

ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_one_target"
    CHECK (num_nonnulls("targetOrgUnitId", "targetUserId") = 1);

-- A person has no subtree, so the flag must not read as if it did.
ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_no_descendants_for_user_target"
    CHECK ("targetUserId" IS NULL OR "includeDescendants" = false);

-- Uniqueness is four partial indexes, not one composite.
--
-- Postgres treats every NULL as distinct in a unique index, so
-- UNIQUE(viewer*, target*) over four nullable columns would allow the same
-- grant to be inserted any number of times — the exact failure the original
-- single unique index existed to prevent.
DROP INDEX IF EXISTS "org_unit_scopes_viewerOrgUnitId_targetOrgUnitId_key";

CREATE UNIQUE INDEX "org_unit_scopes_unit_unit_key"
    ON "org_unit_scopes"("viewerOrgUnitId", "targetOrgUnitId")
    WHERE "viewerOrgUnitId" IS NOT NULL AND "targetOrgUnitId" IS NOT NULL;

CREATE UNIQUE INDEX "org_unit_scopes_unit_user_key"
    ON "org_unit_scopes"("viewerOrgUnitId", "targetUserId")
    WHERE "viewerOrgUnitId" IS NOT NULL AND "targetUserId" IS NOT NULL;

CREATE UNIQUE INDEX "org_unit_scopes_user_unit_key"
    ON "org_unit_scopes"("viewerUserId", "targetOrgUnitId")
    WHERE "viewerUserId" IS NOT NULL AND "targetOrgUnitId" IS NOT NULL;

CREATE UNIQUE INDEX "org_unit_scopes_user_user_key"
    ON "org_unit_scopes"("viewerUserId", "targetUserId")
    WHERE "viewerUserId" IS NOT NULL AND "targetUserId" IS NOT NULL;

-- The resolve path reads grants by viewer, and now asks for both kinds in one
-- query — the group index alone would leave the user half sequential.
CREATE INDEX "org_unit_scopes_companyId_viewerUserId_idx"
    ON "org_unit_scopes"("companyId", "viewerUserId");

-- Cascade, matching the group ends: a grant naming a deleted person is not a
-- grant. Users are never hard-deleted today (status columns only), so this is
-- a guard rather than a routine path.
ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_viewerUserId_fkey"
    FOREIGN KEY ("viewerUserId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_unit_scopes"
    ADD CONSTRAINT "org_unit_scopes_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
