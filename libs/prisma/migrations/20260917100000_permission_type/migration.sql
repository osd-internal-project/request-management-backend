-- คอลัมน์ `type` แยกสิทธิ์ของคนออกจาก scope ของบัญชีบริการ (AUTH-06)
ALTER TABLE "permissions" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'human';

-- backfill: แถวทั้งหมดมีอยู่ก่อนคอลัมน์นี้ ปล่อยให้ default อย่างเดียวแปลว่า
-- integration.* ทุกตัวจะค้างเป็น human
UPDATE "permissions" SET "type" = 'service' WHERE "module" = 'integration';

CREATE INDEX "permissions_type_idx" ON "permissions"("type");
