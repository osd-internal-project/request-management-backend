-- CD-202: minimum margin per work type; a type left out uses minMarginPct.
ALTER TABLE "crm_company_configs" ADD COLUMN "minMarginByWorkType" JSONB NOT NULL DEFAULT '{}';
