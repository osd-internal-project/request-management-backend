-- CD-267 (CD-22 KBMS) — passages of published knowledge articles and their
-- embeddings, for searching by meaning. REAL[] with no fixed dimension:
-- pgvector is not installed, and the size depends on the embedding model.
CREATE TABLE "kb_chunks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "articleVersion" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vector" REAL[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kb_chunks_companyId_model_idx" ON "kb_chunks"("companyId", "model");

CREATE UNIQUE INDEX "kb_chunks_articleId_seq_key" ON "kb_chunks"("articleId", "seq");
