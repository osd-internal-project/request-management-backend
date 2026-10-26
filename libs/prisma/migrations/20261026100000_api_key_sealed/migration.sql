-- ผู้ดูแลกดดูกุญแจย้อนหลังได้ (26 ต.ค. 2569) — key เดิมเป็น NULL ดูไม่ได้ ออกใหม่เท่านั้น
ALTER TABLE "api_keys" ADD COLUMN     "keyEnc" TEXT;
