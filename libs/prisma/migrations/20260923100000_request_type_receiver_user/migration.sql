-- ผู้รับเรื่องประจำ request type (optional). null = ผู้ยื่นเลือกเอง เหมือนเดิม.

-- AlterTable
ALTER TABLE "request_types" ADD COLUMN "receiverUserId" TEXT;

-- AddForeignKey
ALTER TABLE "request_types" ADD CONSTRAINT "request_types_receiverUserId_fkey" FOREIGN KEY ("receiverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
