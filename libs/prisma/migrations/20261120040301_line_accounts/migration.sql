-- CreateTable
CREATE TABLE "line_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "loginChannelId" TEXT NOT NULL DEFAULT '',
    "loginChannelSecretEnc" TEXT,
    "oaBasicId" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_line_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "pictureUrl" TEXT,
    "isFriend" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_line_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_settings_companyId_key" ON "line_settings"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "user_line_accounts_userId_companyId_key" ON "user_line_accounts"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "user_line_accounts_companyId_lineUserId_key" ON "user_line_accounts"("companyId", "lineUserId");

-- AddForeignKey
ALTER TABLE "user_line_accounts" ADD CONSTRAINT "user_line_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_line_accounts" ADD CONSTRAINT "user_line_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
