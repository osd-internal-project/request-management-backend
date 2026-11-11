-- งานขายอัตโนมัติติดขัด (11 พ.ย. 2569): เหตุผลที่ workflow เรียก crm/ai/* ไม่สำเร็จ ให้หน้า Lead/ดีลแสดง
CREATE TABLE "sales_automation_issues" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "step" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '[]',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sales_automation_issues_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_automation_issues_leadId_resolvedAt_idx" ON "sales_automation_issues"("leadId", "resolvedAt");
CREATE INDEX "sales_automation_issues_opportunityId_resolvedAt_idx" ON "sales_automation_issues"("opportunityId", "resolvedAt");
CREATE INDEX "sales_automation_issues_companyId_occurredAt_idx" ON "sales_automation_issues"("companyId", "occurredAt");
