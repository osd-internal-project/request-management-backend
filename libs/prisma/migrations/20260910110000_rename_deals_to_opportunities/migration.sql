-- PO 10 ก.ย. 2026: "Deal" กลายเป็น "Opportunity" ทั้งระบบ และรหัสขึ้นต้น OPP- แทน DL-
-- Rename in place (ไม่ drop/create) — ข้อมูลและ FK เดิมอยู่ครบ

-- Enum
ALTER TYPE "DealStage" RENAME TO "OpportunityStage";

-- Tables
ALTER TABLE "deals" RENAME TO "opportunities";
ALTER TABLE "deal_products" RENAME TO "opportunity_products";
ALTER TABLE "deal_lost_reasons" RENAME TO "opportunity_lost_reasons";
ALTER TABLE "deal_code_counters" RENAME TO "opportunity_code_counters";

-- Columns
ALTER TABLE "opportunities" RENAME COLUMN "dealCode" TO "opportunityCode";
ALTER TABLE "opportunity_products" RENAME COLUMN "dealId" TO "opportunityId";
ALTER TABLE "leads" RENAME COLUMN "convertedDealId" TO "convertedOpportunityId";

-- Primary keys / unique indexes / indexes (ชื่อตามที่ Prisma จะสร้างให้ schema ใหม่)
ALTER INDEX "deals_pkey" RENAME TO "opportunities_pkey";
ALTER INDEX "deals_dealCode_key" RENAME TO "opportunities_opportunityCode_key";
ALTER INDEX "deals_companyId_stage_idx" RENAME TO "opportunities_companyId_stage_idx";
ALTER INDEX "deals_companyId_customerId_idx" RENAME TO "opportunities_companyId_customerId_idx";
ALTER INDEX "deals_companyId_ownerUserId_idx" RENAME TO "opportunities_companyId_ownerUserId_idx";
ALTER INDEX "deals_companyId_ownerOrgUnitId_idx" RENAME TO "opportunities_companyId_ownerOrgUnitId_idx";
ALTER INDEX "deal_products_pkey" RENAME TO "opportunity_products_pkey";
ALTER INDEX "deal_products_dealId_productCode_key" RENAME TO "opportunity_products_opportunityId_productCode_key";
ALTER INDEX "deal_lost_reasons_pkey" RENAME TO "opportunity_lost_reasons_pkey";
ALTER INDEX "deal_lost_reasons_companyId_code_key" RENAME TO "opportunity_lost_reasons_companyId_code_key";
ALTER INDEX "deal_code_counters_pkey" RENAME TO "opportunity_code_counters_pkey";
ALTER INDEX "deal_code_counters_companyId_key" RENAME TO "opportunity_code_counters_companyId_key";
ALTER INDEX "leads_convertedDealId_key" RENAME TO "leads_convertedOpportunityId_key";

-- Foreign keys
ALTER TABLE "opportunities" RENAME CONSTRAINT "deals_companyId_fkey" TO "opportunities_companyId_fkey";
ALTER TABLE "opportunities" RENAME CONSTRAINT "deals_customerId_fkey" TO "opportunities_customerId_fkey";
ALTER TABLE "opportunity_products" RENAME CONSTRAINT "deal_products_dealId_fkey" TO "opportunity_products_opportunityId_fkey";
ALTER TABLE "opportunity_lost_reasons" RENAME CONSTRAINT "deal_lost_reasons_companyId_fkey" TO "opportunity_lost_reasons_companyId_fkey";
ALTER TABLE "opportunity_code_counters" RENAME CONSTRAINT "deal_code_counters_companyId_fkey" TO "opportunity_code_counters_companyId_fkey";
ALTER TABLE "leads" RENAME CONSTRAINT "leads_convertedDealId_fkey" TO "leads_convertedOpportunityId_fkey";

-- Data: รหัสเดิม DL-… → OPP-… และ ref ที่ชี้มาจากคำขอ/timeline เปลี่ยนชนิดตาม
UPDATE "opportunities" SET "opportunityCode" = 'OPP-' || substring("opportunityCode" from 4)
WHERE "opportunityCode" LIKE 'DL-%';
UPDATE "requests" SET "refType" = 'opportunity' WHERE "refType" = 'deal';
UPDATE "requests" SET "refId" = 'OPP-' || substring("refId" from 4)
WHERE "refType" = 'opportunity' AND "refId" LIKE 'DL-%';
UPDATE "customer_timeline_events" SET "refType" = 'opportunity' WHERE "refType" = 'deal';
UPDATE "customer_timeline_events" SET "eventType" = 'opportunity.' || substring("eventType" from 6)
WHERE "eventType" LIKE 'deal.%';
UPDATE "audit_logs" SET "resourceType" = 'opportunity' WHERE "resourceType" = 'deal';
