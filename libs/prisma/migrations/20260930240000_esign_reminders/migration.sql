-- CD-171 เตือนซ้ำและวันหมดอายุของคำขอลงนาม
-- AlterTable
ALTER TABLE "esign_signers" ADD COLUMN     "tokenCipher" TEXT;

