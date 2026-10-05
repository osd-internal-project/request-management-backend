-- CD-260 (CD-22 KBMS) — กลั่นกรองและอนุมัติบทความ: ส่งตรวจ ฉบับปรับปรุง เวอร์ชัน รอบทบทวน รวมบทความซ้ำ.
-- AlterTable
ALTER TABLE "kb_articles" ADD COLUMN     "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN     "lastReviewedBy" TEXT,
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "nextReviewOn" DATE,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewRemindedOn" DATE,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "kb_categories" ADD COLUMN     "reviewMonths" INTEGER;

-- CreateTable
CREATE TABLE "kb_article_revisions" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "categoryId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changeNote" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "kb_article_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_versions" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "categoryId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changeNote" TEXT NOT NULL DEFAULT '',
    "writtenBy" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_article_revisions_articleId_status_idx" ON "kb_article_revisions"("articleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kb_article_versions_articleId_version_key" ON "kb_article_versions"("articleId", "version");


-- Articles published before CD-260: their author answers for them, they are
-- version 1, and they come up for review a year after they were published.
UPDATE "kb_articles" SET "ownerId" = "authorId" WHERE "ownerId" IS NULL;
INSERT INTO "kb_article_versions" ("id", "articleId", "version", "title", "summary", "body",
  "categoryId", "tags", "productCodes", "productGroups", "changeNote", "writtenBy", "approvedBy", "approvedAt")
SELECT gen_random_uuid()::text, a."id", 1, a."title", a."summary", a."body", a."categoryId", a."tags",
  a."productCodes", a."productGroups", '', a."authorId", COALESCE(a."publishedBy", a."authorId"),
  COALESCE(a."publishedAt", a."updatedAt")
FROM "kb_articles" a WHERE a."publishedAt" IS NOT NULL;
UPDATE "kb_articles" SET "version" = 1,
  "nextReviewOn" = (COALESCE("publishedAt", "updatedAt") + interval '12 months')::date
WHERE "publishedAt" IS NOT NULL;
