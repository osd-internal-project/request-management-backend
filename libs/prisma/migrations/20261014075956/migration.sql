-- CreateTable
CREATE TABLE "chat_widget_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "httpUrl" TEXT,
    "httpsUrl" TEXT,
    "publicId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_widget_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_widget_settings_companyId_key" ON "chat_widget_settings"("companyId");
