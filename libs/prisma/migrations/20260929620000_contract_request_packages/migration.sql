-- CD-145 ข้อมูลการค้าและขอบเขตงานที่แนบคำขอจัดทำสัญญา
-- CreateTable
CREATE TABLE "contract_request_packages" (
    "requestId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "negotiationRoundNo" INTEGER,
    "tradeTerms" JSONB NOT NULL DEFAULT '[]',
    "solutionId" TEXT,
    "solutionTitle" TEXT,
    "solutionVersionNo" INTEGER,
    "inScope" JSONB NOT NULL DEFAULT '[]',
    "outOfScope" JSONB NOT NULL DEFAULT '[]',
    "deliverables" JSONB NOT NULL DEFAULT '[]',
    "assumptionsText" TEXT,
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedBy" TEXT,

    CONSTRAINT "contract_request_packages_pkey" PRIMARY KEY ("requestId")
);

-- CreateIndex
CREATE INDEX "contract_request_packages_companyId_idx" ON "contract_request_packages"("companyId");

