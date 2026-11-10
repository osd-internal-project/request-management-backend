-- D-Callcenter softphone: each user's SIP line per company (password sealed
-- with CONFIG_SECRET_KEY), and `phone` as the channel of a CALL_LOG request.
-- Additive only: a new enum value and a new table; no existing row changes.

-- AlterEnum
ALTER TYPE "IntakeChannel" ADD VALUE 'phone';

-- CreateTable
CREATE TABLE "softphone_extensions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "passwordSealed" TEXT NOT NULL,
    "wssUrl" TEXT NOT NULL,
    "sipServer" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "softphone_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "softphone_extensions_companyId_userId_key" ON "softphone_extensions"("companyId", "userId");

-- Permission: the catalog row (user-service would add it at boot anyway) and a
-- grant to every role that already manages the chat widget, so the settings
-- page is reachable without a re-seed.
INSERT INTO "permissions" ("code", "module", "type")
VALUES ('admin.softphone.manage', 'admin', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'admin.softphone.manage'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'admin.chat-widget.manage'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
