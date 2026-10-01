-- CD-201: every quotation goes to price approval (PRA); the low-margin DSC
-- request was the old default. Existing rows switch when `prisma:seed`
-- creates the PRA type, so a company is never pointed at a missing type.
ALTER TABLE "crm_company_configs" ALTER COLUMN "quotationApprovalTypeCode" SET DEFAULT 'PRA';
