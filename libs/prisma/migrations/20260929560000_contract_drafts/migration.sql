-- CD-146 แม่แบบและร่างสัญญา
-- CreateTable
CREATE TABLE "contract_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ContractKind" NOT NULL DEFAULT 'standard',
    "clauses" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_drafts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateClauses" JSONB NOT NULL DEFAULT '[]',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "latestVersionNo" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_draft_versions" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "clauses" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "contract_draft_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_templates_companyId_code_key" ON "contract_templates"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "contract_drafts_requestId_key" ON "contract_drafts"("requestId");

-- CreateIndex
CREATE INDEX "contract_drafts_companyId_idx" ON "contract_drafts"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_draft_versions_draftId_versionNo_key" ON "contract_draft_versions"("draftId", "versionNo");

-- AddForeignKey
ALTER TABLE "contract_drafts" ADD CONSTRAINT "contract_drafts_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "contract_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_draft_versions" ADD CONSTRAINT "contract_draft_versions_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "contract_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

