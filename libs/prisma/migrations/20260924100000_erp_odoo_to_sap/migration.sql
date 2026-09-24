-- ERP เปลี่ยนจาก Odoo เป็น SAP (24 ก.ย. 2569). ไม่เคยต่อ Odoo จริง — แถว 'odoo'
-- ทั้งหมดมาจาก driver mock — ย้ายไปเป็น 'sap' เพื่อให้เลขที่ผูกไว้และงานที่ค้างในคิว
-- ทำงานต่อกับ ERP ใหม่. ข้อมูลอย่างเดียว ไม่แตะโครงตาราง.
UPDATE "customer_external_codes" SET "system" = 'sap' WHERE "system" = 'odoo';
UPDATE "integration_sync_jobs" SET "system" = 'sap' WHERE "system" = 'odoo';
