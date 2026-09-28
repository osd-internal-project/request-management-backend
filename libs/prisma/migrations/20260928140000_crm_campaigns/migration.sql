-- CD-71 แคมเปญ — ผูก Lead กับกิจกรรมการตลาด แล้ววัดผลถึงยอดขาย.

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "budget" DECIMAL(14,2),
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "campaignId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_companyId_code_key" ON "campaigns"("companyId", "code");

-- CreateIndex
CREATE INDEX "leads_campaignId_idx" ON "leads"("campaignId");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
