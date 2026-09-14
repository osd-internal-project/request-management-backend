-- API key หนึ่งใบต่อหนึ่งช่องทาง (14 ก.ย. 2569).
--
-- มาพร้อมข้อกำหนดว่า POST /integrations/crm/leads ต้องใช้ *แค่ API key* —
-- ไม่มี header อื่น ไม่มีอะไรให้ผู้เรียกกรอกผิด. สามสิ่งที่เคยต้องบอกกันคนละทาง
-- จึงย้ายมาอยู่บนกุญแจใบเดียว:
--
--   companyId  — Lead เข้าบริษัทไหน (เดิมมาจาก header X-Company-Id)
--   sourceCode — มาจากช่องทางไหน (เดิมผู้เรียกพิมพ์มาใน body ได้ตามใจ)
--   scopes     — ใบนี้ทำอะไรได้บ้าง (เดิมทุก key ได้สิทธิ์เต็มชุดเท่ากันหมด)
--
-- ทั้งสามคอลัมน์ NULL/ว่างได้ และนั่นคือ key ทุกใบที่ออกไปก่อนหน้านี้ — พฤติกรรม
-- เดิมทุกอย่าง: ส่ง X-Company-Id เอง, source_code มาจาก body, สิทธิ์เต็มชุดของ
-- integration client. ไม่มี backfill เพราะไม่มีอะไรจะเดาแทนผู้ถือ key ได้.
--
-- `scopes` เป็น array ว่าง ไม่ใช่ NULL: "ไม่จำกัด" กับ "จำกัดเป็นศูนย์อย่าง" ต้อง
-- ไม่ใช่ค่าเดียวกัน และ default ที่เป็น array ว่างอ่านง่ายกว่า NULL ที่ต้องตีความ.

ALTER TABLE "api_keys" ADD COLUMN "companyId" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "sourceCode" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
