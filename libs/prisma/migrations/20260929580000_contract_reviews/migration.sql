-- CD-147 รอบตรวจสัญญาและความเห็นรายข้อ
-- CreateTable
CREATE TABLE "contract_review_rounds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "roundNo" INTEGER NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedBy" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedVersionNo" INTEGER,

    CONSTRAINT "contract_review_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_review_comments" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "clauseKey" TEXT NOT NULL,
    "clauseHeading" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',
    "response" TEXT,
    "respondedBy" TEXT,
    "respondedAt" TIMESTAMP(3),
    "resolvedInVersion" INTEGER,

    CONSTRAINT "contract_review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_review_rounds_draftId_roundNo_key" ON "contract_review_rounds"("draftId", "roundNo");

-- CreateIndex
CREATE INDEX "contract_review_comments_roundId_status_idx" ON "contract_review_comments"("roundId", "status");

-- AddForeignKey
ALTER TABLE "contract_review_rounds" ADD CONSTRAINT "contract_review_rounds_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "contract_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_review_comments" ADD CONSTRAINT "contract_review_comments_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "contract_review_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "contract_review_rounds"
  ADD CONSTRAINT "contract_review_rounds_status_check"
    CHECK ("status" IN ('open', 'closed'));
ALTER TABLE "contract_review_comments"
  ADD CONSTRAINT "contract_review_comments_status_check"
    CHECK ("status" IN ('open', 'resolved', 'declined'));
