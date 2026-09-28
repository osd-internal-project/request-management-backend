-- CreateTable
CREATE TABLE "trade_term_standards" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "standardValue" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "trade_term_standards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiation_rounds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "occurredOn" DATE NOT NULL,
    "summary" TEXT,
    "terms" JSONB NOT NULL,
    "nonStandardCount" INTEGER NOT NULL DEFAULT 0,
    "legalRequestId" TEXT,
    "legalSendError" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_term_standards_companyId_code_key" ON "trade_term_standards"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "negotiation_rounds_opportunityId_roundNo_key" ON "negotiation_rounds"("opportunityId", "roundNo");

-- AddForeignKey
ALTER TABLE "trade_term_standards" ADD CONSTRAINT "trade_term_standards_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_rounds" ADD CONSTRAINT "negotiation_rounds_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

