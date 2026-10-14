-- DropIndex
DROP INDEX "chat_widget_settings_companyId_key";

-- AlterTable
ALTER TABLE "chat_widget_settings" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'ผู้ช่วย AI',
ADD COLUMN     "orgWide" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "chat_widget_groups" (
    "widgetId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "chat_widget_groups_pkey" PRIMARY KEY ("widgetId","orgUnitId")
);

-- CreateIndex
CREATE INDEX "chat_widget_groups_orgUnitId_idx" ON "chat_widget_groups"("orgUnitId");

-- CreateIndex
CREATE INDEX "chat_widget_settings_companyId_idx" ON "chat_widget_settings"("companyId");

-- AddForeignKey
ALTER TABLE "chat_widget_groups" ADD CONSTRAINT "chat_widget_groups_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "chat_widget_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_widget_groups" ADD CONSTRAINT "chat_widget_groups_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "org_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: the widget that lived in the frontend env becomes each company's
-- org-wide default. Only companies that have no widget yet.
INSERT INTO "chat_widget_settings"
  ("id", "companyId", "name", "httpUrl", "publicId", "active", "orgWide", "isDefault", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", 'ผู้ช่วย AI', 'http://192.168.31.52', 'feKqnrmmNS0jfdjCnXND5Kql', true, true, true, 0, NOW(), NOW()
FROM "companies" c
WHERE NOT EXISTS (SELECT 1 FROM "chat_widget_settings" w WHERE w."companyId" = c."id");

-- Permission: the catalog row (user-service would add it at boot anyway) and a
-- grant to every role that already manages the LLM Gateway (admin,
-- uat_superadmin), so the settings page is reachable without a re-seed.
INSERT INTO "permissions" ("code", "module", "type")
VALUES ('admin.chat-widget.manage', 'admin', 'human')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionCode")
SELECT rp."roleId", 'admin.chat-widget.manage'
FROM "role_permissions" rp
WHERE rp."permissionCode" = 'admin.llm.manage'
ON CONFLICT ("roleId", "permissionCode") DO NOTHING;
