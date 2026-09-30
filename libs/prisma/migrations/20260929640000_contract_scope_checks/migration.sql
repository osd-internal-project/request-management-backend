-- CD-150 ตรวจขอบเขตงาน
-- CreateTable
CREATE TABLE "contract_scope_checks" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_scope_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_scope_checks_draftId_versionNo_key" ON "contract_scope_checks"("draftId", "versionNo");

-- AddForeignKey
ALTER TABLE "contract_scope_checks" ADD CONSTRAINT "contract_scope_checks_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "contract_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "contract_scope_checks"
  ADD CONSTRAINT "contract_scope_checks_status_check"
    CHECK ("status" IN ('consistent', 'inconsistent'));
