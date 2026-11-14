-- 14 พ.ย. 2569 — integration กลาง (companyId NULL) จำกัดบริษัทที่ key กลางเรียกในนามได้.
-- ว่าง = ทุกบริษัท ตามพฤติกรรมเดิม แถวเดิมจึงไม่เปลี่ยนการทำงาน.
ALTER TABLE "integrations" ADD COLUMN "allowedCompanyIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
