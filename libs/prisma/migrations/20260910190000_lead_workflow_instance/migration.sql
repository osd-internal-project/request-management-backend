-- Lead ผูกกับ instance ของ workflow `lwf-0001` บน OSD Workflow (10 ก.ย. 2569).
--
-- signal ที่บอกว่า "มีกิจกรรมเสร็จแล้ว" ยิงไปที่
-- POST /api/v1/workflow-instances/{id}/signal ซึ่งอ้าง instance ตรง ๆ
-- จึงต้องเก็บ id ที่ได้ตอน start ไว้กับ Lead. NULL ได้เสมอ — Lead ที่รับเข้ามา
-- ก่อนวันนี้ และ Lead ที่ start ไม่สำเร็จ ยังทำงานได้ตามปกติ.

ALTER TABLE "leads" ADD COLUMN "workflowInstanceId" TEXT;
