-- CD-259 (CD-22 KBMS) — คลังบทความความรู้.
-- CreateTable
CREATE TABLE "kb_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_articles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "articleNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "categoryId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "authorId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "helpfulYes" INTEGER NOT NULL DEFAULT 0,
    "helpfulNo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_article_ratings" (
    "articleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_article_ratings_pkey" PRIMARY KEY ("articleId","userId")
);

-- CreateTable
CREATE TABLE "kb_article_files" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "kb_article_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_categories_companyId_idx" ON "kb_categories"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_categories_companyId_parentId_name_key" ON "kb_categories"("companyId", "parentId", "name");

-- CreateIndex
CREATE INDEX "kb_articles_companyId_status_idx" ON "kb_articles"("companyId", "status");

-- CreateIndex
CREATE INDEX "kb_articles_categoryId_idx" ON "kb_articles"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_articles_companyId_articleNo_key" ON "kb_articles"("companyId", "articleNo");

-- CreateIndex
CREATE INDEX "kb_article_files_articleId_idx" ON "kb_article_files"("articleId");

