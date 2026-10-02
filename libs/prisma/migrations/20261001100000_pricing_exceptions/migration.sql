-- CD-205: pricing exception register, written when a quotation's price request is decided.
-- CreateTable
CREATE TABLE "pricing_exceptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestNo" TEXT,
    "quotationId" TEXT NOT NULL,
    "quotationNo" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerId" TEXT,
    "partyName" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "netTotal" DECIMAL(14,2) NOT NULL,
    "workType" TEXT,
    "marginPct" DECIMAL(7,2),
    "minMarginPct" DECIMAL(7,2),
    "productCode" TEXT,
    "description" TEXT,
    "systemPrice" DECIMAL(14,2),
    "unitPrice" DECIMAL(14,2),
    "caps" JSONB,
    "reason" TEXT,
    "requestedBy" TEXT,
    "requestedByName" TEXT,
    "decision" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "approverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approverNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_exceptions_companyId_createdAt_idx" ON "pricing_exceptions"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "pricing_exceptions_companyId_customerId_idx" ON "pricing_exceptions"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "pricing_exceptions_opportunityId_idx" ON "pricing_exceptions"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_exceptions_requestId_kind_subjectKey_key" ON "pricing_exceptions"("requestId", "kind", "subjectKey");

