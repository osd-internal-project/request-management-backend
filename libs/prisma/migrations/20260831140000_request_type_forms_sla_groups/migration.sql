-- ประเภทคำขอ gains a second form, real SLA coverage, and group eligibility.
-- 31 Aug 2026.
--
-- **Second form.** A request type described one form, filled in by the
-- requester. The work the receiver does — what was checked, what was issued,
-- what it cost — had nowhere to go, so it was typed into the requester's
-- fields or into nothing. `receiverFormSchema` is nullable because most of the
-- forty imported types have no second form and must not suddenly demand one.
--
-- **SLA coverage.** `slaBusinessHours`/`businessHours` were booleans that no
-- code ever read: `SlaService` added `hours × 3_600_000` to the start time and
-- called it a deadline, so the checkbox on screen A2 changed a label and
-- nothing else. The boolean also could not tell "office hours every day" from
-- "office hours on working days". Mapped `true → H8X5` and `false → H24X7`,
-- which preserves what the setting *said* even though nothing acted on it.
--
-- **Group eligibility.** No rows means every group may raise the type, so the
-- forty existing types keep working with an empty table and switching this on
-- is opt-in per type. A named group covers its whole subtree, resolved through
-- `org_closure` at query time rather than expanded here — expanding would make
-- moving a group in the chart silently revoke what it may raise.
--
-- **Working hours** default to 08:30–17:30 rather than 09:00–18:00, and the
-- rows still carrying the old defaults are moved with it. A company that had
-- deliberately set something else is left alone.

CREATE TYPE "SlaCoverage" AS ENUM ('H24X7', 'H8X7', 'H8X5');

ALTER TABLE "request_types" ADD COLUMN "receiverFormSchema" JSONB;

ALTER TABLE "request_types" ADD COLUMN "slaCoverage" "SlaCoverage" NOT NULL DEFAULT 'H24X7';
UPDATE "request_types" SET "slaCoverage" = 'H8X5' WHERE "slaBusinessHours" = true;
ALTER TABLE "request_types" DROP COLUMN "slaBusinessHours";

ALTER TABLE "sla_configs" ADD COLUMN "coverage" "SlaCoverage" NOT NULL DEFAULT 'H24X7';
UPDATE "sla_configs" SET "coverage" = 'H8X5' WHERE "businessHours" = true;
ALTER TABLE "sla_configs" DROP COLUMN "businessHours";

CREATE TABLE "request_type_org_units" (
    "requestTypeId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    CONSTRAINT "request_type_org_units_pkey" PRIMARY KEY ("requestTypeId","orgUnitId")
);

CREATE INDEX "request_type_org_units_orgUnitId_idx" ON "request_type_org_units"("orgUnitId");

ALTER TABLE "request_type_org_units" ADD CONSTRAINT "request_type_org_units_requestTypeId_fkey"
  FOREIGN KEY ("requestTypeId") REFERENCES "request_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_type_org_units" ADD CONSTRAINT "request_type_org_units_orgUnitId_fkey"
  FOREIGN KEY ("orgUnitId") REFERENCES "org_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "holiday_calendars" ALTER COLUMN "workdayStartMinute" SET DEFAULT 510;
ALTER TABLE "holiday_calendars" ALTER COLUMN "workdayEndMinute" SET DEFAULT 1050;
UPDATE "holiday_calendars"
   SET "workdayStartMinute" = 510, "workdayEndMinute" = 1050
 WHERE "workdayStartMinute" = 540 AND "workdayEndMinute" = 1080;
