-- อีเมลของงานขาย (5 พ.ย. 2569): ส่งจาก mailbox บริษัทผ่าน Microsoft Graph + คำตอบในเธรด
CREATE TABLE "crm_emails" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "quotationId" TEXT,
    "direction" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "graphMessageId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "replyToEmailId" TEXT,
    "intent" TEXT,
    "intentReason" TEXT,
    "intentSource" TEXT,
    "error" TEXT,
    "sentBy" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_emails_companyId_internetMessageId_key" ON "crm_emails"("companyId", "internetMessageId");
CREATE INDEX "crm_emails_companyId_leadId_occurredAt_idx" ON "crm_emails"("companyId", "leadId", "occurredAt");
CREATE INDEX "crm_emails_companyId_opportunityId_occurredAt_idx" ON "crm_emails"("companyId", "opportunityId", "occurredAt");
CREATE INDEX "crm_emails_conversationId_idx" ON "crm_emails"("conversationId");

-- ใบที่ใช้ราคามาตรฐานล้วนอนุมัติทันที (ผู้ใช้ 5 พ.ย. 2569) — false = ยื่น PRA ทุกใบเหมือนเดิม
ALTER TABLE "crm_company_configs" ADD COLUMN "autoApproveStandardPrice" BOOLEAN NOT NULL DEFAULT true;

INSERT INTO "permissions" ("code", "module", "type") VALUES
  ('integration.crm.sales.read.all', 'integration', 'service'),
  ('integration.crm.email.send', 'integration', 'service'),
  ('integration.crm.email.read', 'integration', 'service'),
  ('integration.crm.quotation.create', 'integration', 'service'),
  ('integration.crm.quotation.accept', 'integration', 'service')
ON CONFLICT ("code") DO NOTHING;
