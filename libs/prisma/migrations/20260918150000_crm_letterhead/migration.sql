-- ใบเสนอราคา PDF: หัวกระดาษของบริษัทผู้ขาย + เงื่อนไขท้ายใบ ตั้งค่าได้ต่อบริษัท.
ALTER TABLE "crm_company_configs"
  ADD COLUMN "letterheadNameTh" TEXT,
  ADD COLUMN "letterheadNameEn" TEXT,
  ADD COLUMN "letterheadTaxId" TEXT,
  ADD COLUMN "letterheadBranch" TEXT,
  ADD COLUMN "letterheadAddress" TEXT,
  ADD COLUMN "letterheadPhone" TEXT,
  ADD COLUMN "letterheadEmail" TEXT,
  ADD COLUMN "letterheadWebsite" TEXT,
  ADD COLUMN "letterheadLogo" TEXT,
  ADD COLUMN "quotationTerms" TEXT;
