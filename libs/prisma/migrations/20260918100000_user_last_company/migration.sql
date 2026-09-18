-- บริษัทที่ผู้ใช้สลับไปล่าสุด (18 Sep 2026).
--
-- ก่อนหน้านี้ไม่มีที่ไหนในระบบจำได้เลยว่าผู้ใช้เลือกบริษัทไหนไว้: cookie
-- `active_company` ฝั่ง frontend ถูกลบทิ้งตอน logout โดยตั้งใจ และ callback หลัง
-- login ไม่เคยเขียนกลับ คนที่อยู่หลายบริษัทจึงเด้งกลับ `primaryCompanyId` ทุกครั้ง
-- ที่ login ใหม่ คอลัมน์นี้คือแหล่งความจริงฝั่ง server ที่ทำให้จำข้ามเครื่องและ
-- ข้ามเบราว์เซอร์ได้
--
-- แยกจาก `primaryCompanyId` เพราะคนละความหมาย อันนั้นเป็นสังกัดหลักที่ผู้ดูแล
-- กำหนดให้และเป็นข้อเท็จจริงทางบุคคล ส่วนอันนี้เจ้าตัวเปลี่ยนเองได้ตลอดเวลา การ
-- เขียนทับ `primaryCompanyId` แทนจะทำให้สังกัดหลักเปลี่ยนไปเงียบ ๆ ทุกครั้งที่มีคน
-- กดสลับบริษัทดู
--
-- nullable และไม่ backfill: แถวเดิมทุกแถวเป็น NULL แล้วตกไปใช้ `primaryCompanyId`
-- ซึ่งคือพฤติกรรมวันนี้ทุกประการ migration นี้จึงไม่เปลี่ยนอะไรของใครจนกว่าเขาจะ
-- กดสลับบริษัทครั้งแรก
--
-- ON DELETE SET NULL ตามแบบเดียวกับ `users_primaryCompanyId_fkey` — บริษัทที่หายไป
-- ต้องไม่ทำให้ผู้ใช้ login ไม่ได้
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "lastCompanyId" TEXT;

CREATE INDEX IF NOT EXISTS "users_lastCompanyId_idx" ON "users"("lastCompanyId");

ALTER TABLE "users"
  ADD CONSTRAINT "users_lastCompanyId_fkey" FOREIGN KEY ("lastCompanyId")
  REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
