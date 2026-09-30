-- AlterTable
ALTER TABLE "project_milestones" ADD COLUMN     "penaltyApplies" BOOLEAN NOT NULL DEFAULT false;


-- A milestone that unlocks a payment on a contract with a delay penalty is
-- subject to it.
UPDATE "project_milestones" m
SET "penaltyApplies" = true
FROM "projects" p
JOIN "contract_terms" t ON t."contractId" = p."contractId"
WHERE m."projectId" = p."id"
  AND m."installmentId" IS NOT NULL
  AND t."penaltyRatePct" IS NOT NULL;
