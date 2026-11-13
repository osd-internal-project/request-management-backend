-- 13 พ.ย. 2569 — งานขายอัตโนมัติถาม requirement ก่อนออกใบเสนอราคา:
-- คำถามต่อ product เก็บบนชุดรายการ; item ที่จำนวนไม่คูณตามจำนวนที่ลูกค้าขอ
ALTER TABLE "product_bundles" ADD COLUMN "requirements" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "product_bundle_items" ADD COLUMN "fixedQuantity" BOOLEAN NOT NULL DEFAULT false;
