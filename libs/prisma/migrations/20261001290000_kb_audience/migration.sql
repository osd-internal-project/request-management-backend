-- CD-261 (CD-22 KBMS) — ชั้นการเผยแพร่: ภายใน · ลูกค้าทุกราย · ลูกค้าเฉพาะราย (Portal).
-- AlterTable
ALTER TABLE "kb_article_revisions" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'internal',
ADD COLUMN     "customerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "kb_article_versions" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'internal',
ADD COLUMN     "customerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "kb_articles" ADD COLUMN     "audience" TEXT NOT NULL DEFAULT 'internal',
ADD COLUMN     "customerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "portalHelpfulNo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "portalHelpfulYes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "portalViews" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "kb_portal_ratings" (
    "articleId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_portal_ratings_pkey" PRIMARY KEY ("articleId","contactId")
);

