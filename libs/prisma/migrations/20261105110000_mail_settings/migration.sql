-- ตั้งค่า mailbox ของงานขายต่อบริษัทบนหน้าจอ (5 พ.ย. 2569) — แทนการแก้ env;
-- client secret เก็บแบบเข้ารหัสด้วย CONFIG_SECRET_KEY. บริษัทที่ไม่มีแถว ใช้ MAIL_* จาก env.
CREATE TABLE "mail_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "mailbox" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "tenantId" TEXT NOT NULL DEFAULT '',
    "clientId" TEXT NOT NULL DEFAULT '',
    "clientSecretEnc" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mail_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_settings_companyId_key" ON "mail_settings"("companyId");
