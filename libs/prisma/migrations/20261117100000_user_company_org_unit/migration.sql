-- A person's unit per company (17 Nov 2026, user decision): one person sits in OSD's RND
-- and D CALL's RND at once. users."orgUnitId" stays as the primary company's copy.

-- AlterTable
ALTER TABLE "user_companies" ADD COLUMN     "orgUnitId" TEXT;

-- CreateIndex
CREATE INDEX "user_companies_companyId_orgUnitId_idx" ON "user_companies"("companyId", "orgUnitId");

-- AddForeignKey
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- shortcut: every legacy writer of users."orgUnitId" (A3 screen, add-user, keycloak-admin, import and
-- chart scripts) keeps working through these triggers; move them to user_companies and drop the
-- triggers together with users."orgUnitId".
CREATE FUNCTION "user_org_unit_to_membership"() RETURNS trigger AS $$
BEGIN
  -- Unassigning clears only the old unit's company; a move rewrites only the new unit's company,
  -- so placing someone in D CALL never takes them out of OSD.
  IF NEW."orgUnitId" IS NULL AND OLD."orgUnitId" IS NOT NULL THEN
    UPDATE "user_companies" uc SET "orgUnitId" = NULL
    WHERE uc."userId" = NEW."id" AND uc."orgUnitId" = OLD."orgUnitId";
  ELSIF NEW."orgUnitId" IS NOT NULL THEN
    UPDATE "user_companies" uc SET "orgUnitId" = NEW."orgUnitId"
    FROM "org_units" o
    WHERE o."id" = NEW."orgUnitId" AND uc."userId" = NEW."id" AND uc."companyId" = o."companyId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_org_unit_to_membership"
AFTER UPDATE OF "orgUnitId" ON "users"
FOR EACH ROW EXECUTE FUNCTION "user_org_unit_to_membership"();

-- A membership created after the placement (or a new user) picks up a placement in its company.
CREATE FUNCTION "membership_org_unit_from_user"() RETURNS trigger AS $$
BEGIN
  IF NEW."orgUnitId" IS NULL THEN
    SELECT u."orgUnitId" INTO NEW."orgUnitId"
    FROM "users" u JOIN "org_units" o ON o."id" = u."orgUnitId"
    WHERE u."id" = NEW."userId" AND o."companyId" = NEW."companyId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_companies_org_unit_from_user"
BEFORE INSERT ON "user_companies"
FOR EACH ROW EXECUTE FUNCTION "membership_org_unit_from_user"();

-- Backfill: today's single placement belongs to the membership of the company that owns the unit.
UPDATE "user_companies" uc
SET "orgUnitId" = u."orgUnitId"
FROM "users" u
JOIN "org_units" o ON o."id" = u."orgUnitId"
WHERE uc."userId" = u."id"
  AND o."companyId" = uc."companyId";
