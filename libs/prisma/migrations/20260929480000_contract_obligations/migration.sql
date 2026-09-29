-- CreateTable
CREATE TABLE "contract_obligations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "clause" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "dueOn" DATE,
    "status" TEXT NOT NULL DEFAULT 'open',
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "doneNote" TEXT,
    "warnedFor" DATE,
    "overdueFor" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_obligations_contractId_idx" ON "contract_obligations"("contractId");

-- CreateIndex
CREATE INDEX "contract_obligations_ownerUserId_status_idx" ON "contract_obligations"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "contract_obligations_status_dueOn_idx" ON "contract_obligations"("status", "dueOn");

-- AddForeignKey
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "customer_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

