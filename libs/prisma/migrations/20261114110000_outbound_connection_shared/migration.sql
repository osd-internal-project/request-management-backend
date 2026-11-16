-- 14 พ.ย. 2569 — การเชื่อมต่อ agent กลาง: company_id NULL = ใช้ร่วมทุกบริษัทที่ integration อนุญาต.
-- ไม่แตะแถวเดิม; การย้ายแถวรายบริษัทมาเป็นแถวกลางทำแยก (UPDATE ทีละแถว หลังผู้ใช้ยืนยัน).
ALTER TABLE "outbound_connections" ALTER COLUMN "companyId" DROP NOT NULL;
