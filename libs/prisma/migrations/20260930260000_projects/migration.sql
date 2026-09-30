-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('active', 'on_hold', 'closed', 'cancelled');

-- AlterTable
ALTER TABLE "customer_contracts" ADD COLUMN     "signedDocumentId" TEXT,
ADD COLUMN     "signedOn" DATE,
ADD COLUMN     "signedRecordedBy" TEXT,
ADD COLUMN     "signedVia" TEXT;

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "customerId" TEXT,
    "opportunityId" TEXT,
    "solutionVersionId" TEXT,
    "managerUserId" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'active',
    "startOn" DATE,
    "endOn" DATE NOT NULL,
    "contractValue" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "baseline" JSONB NOT NULL,
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_contractId_key" ON "projects"("contractId");

-- CreateIndex
CREATE INDEX "projects_companyId_status_idx" ON "projects"("companyId", "status");

-- CreateIndex
CREATE INDEX "projects_managerUserId_idx" ON "projects"("managerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_companyId_projectNo_key" ON "projects"("companyId", "projectNo");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A contract already signed through e-sign (CD-160) counts as signed.
UPDATE "customer_contracts" c
SET "signedOn" = (e."completedAt" AT TIME ZONE 'Asia/Bangkok')::date,
    "signedVia" = 'esign'
FROM (
  SELECT DISTINCT ON ("refId") "refId", "completedAt"
  FROM "esign_envelopes"
  WHERE "refType" = 'contract' AND "status" = 'completed' AND "completedAt" IS NOT NULL
  ORDER BY "refId", "completedAt" DESC
) e
WHERE e."refId" = c."id" AND c."signedOn" IS NULL;

-- Project numbers: PRJ-{COMPANY_PREFIX}-{SEQ}, as for the other documents.
INSERT INTO "run_number_settings" (
  "id", "companyId", "docType", "scopeKey", "pattern",
  "seqPadding", "startNumber", "resetPeriod", "active", "updatedAt"
)
SELECT gen_random_uuid()::text, c."id", 'PROJECT', '*', 'PRJ-{COMPANY_PREFIX}-{SEQ}',
       6, 1, 'none'::"RunNumberResetPeriod", true, CURRENT_TIMESTAMP
FROM "companies" c
ON CONFLICT DO NOTHING;
