-- ใบเสนอราคาตามแบบฟอร์มบริษัท (11 พ.ย. 2569): ช่องที่แบบฟอร์มพิมพ์แต่ระบบยังไม่มีที่เก็บ
ALTER TABLE "quotations"
  ADD COLUMN "deliveryTime" TEXT,
  ADD COLUMN "warranty" TEXT,
  ADD COLUMN "partyFax" TEXT,
  ADD COLUMN "sellerMobile" TEXT;

ALTER TABLE "crm_company_configs" ADD COLUMN "letterheadFax" TEXT;
