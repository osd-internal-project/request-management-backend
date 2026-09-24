-- CD-88 รายการสินค้าในใบสั่งขาย + สถานะส่งเข้า SAP.
-- CreateEnum
CREATE TYPE "ErpSyncStatus" AS ENUM ('not_ready', 'pending', 'synced', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "sale_orders" ADD COLUMN     "erpLastError" TEXT,
ADD COLUMN     "erpOrderNo" TEXT,
ADD COLUMN     "erpStatus" "ErpSyncStatus" NOT NULL DEFAULT 'not_ready',
ADD COLUMN     "erpSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "sale_order_lines" (
    "id" TEXT NOT NULL,
    "saleOrderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productCode" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "quotationLineId" TEXT,

    CONSTRAINT "sale_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_order_lines_saleOrderId_lineNo_key" ON "sale_order_lines"("saleOrderId", "lineNo");

-- CreateIndex
CREATE INDEX "sale_orders_erpStatus_idx" ON "sale_orders"("erpStatus");

-- AddForeignKey
ALTER TABLE "sale_order_lines" ADD CONSTRAINT "sale_order_lines_saleOrderId_fkey" FOREIGN KEY ("saleOrderId") REFERENCES "sale_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: ใบสั่งขายที่เปิดตามใบเสนอราคาก่อนมีตารางนี้ — copy บรรทัดจากใบเสนอราคา
-- ต้นทางเหมือนที่ `SaleOrdersService.open` ทำตอนนี้.
INSERT INTO "sale_order_lines"
  ("id", "saleOrderId", "lineNo", "productCode", "description", "quantity",
   "unit", "unitPrice", "discountPct", "lineTotal", "quotationLineId")
SELECT gen_random_uuid()::text, so."id", ql."lineNo", ql."productCode",
       ql."description", ql."quantity", ql."unit", ql."unitPrice",
       ql."discountPct", ql."lineTotal", ql."id"
FROM "sale_orders" so
JOIN "quotation_lines" ql ON ql."quotationId" = so."quotationId";

-- ใบที่ยกเลิกแล้วไม่ต้องส่ง; ใบที่เปิดอยู่และมีรายการ → pending. ไม่สร้างแถวคิวที่นี่:
-- core-service รุ่นก่อนหน้าที่ยังรันอยู่ระหว่าง deploy จะหยิบ kind ที่ไม่รู้จักไปทำเป็น
-- receivables แล้วปิดว่าสำเร็จ — `SaleOrderErpSyncService.reconcile` ของรุ่นใหม่
-- สร้างงานให้ใบที่ pending เองภายใน ~5 นาทีหลัง start.
UPDATE "sale_orders" SET "erpStatus" = 'skipped' WHERE "status" = 'cancelled';

UPDATE "sale_orders" so SET "erpStatus" = 'pending'
WHERE so."status" = 'open'
  AND EXISTS (SELECT 1 FROM "sale_order_lines" l WHERE l."saleOrderId" = so."id");
