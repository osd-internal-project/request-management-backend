-- CD-288 (CD-23 AI CARE) — conversations on the customer's 360° timeline,
-- how many AI closed by itself (Data Mart), and answers followed by a
-- handover fed back to KBMS as "handed off".

-- AlterTable
ALTER TABLE "care_conversations" ADD COLUMN     "humanAt" TIMESTAMP(3),
ADD COLUMN     "timelineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "kb_ai_queries" ADD COLUMN     "handedOffAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "care_conversations_status_timelineAt_idx" ON "care_conversations"("status", "timelineAt");

-- CreateIndex
CREATE INDEX "kb_ai_queries_handedOffAt_gapId_idx" ON "kb_ai_queries"("handedOffAt", "gapId");

-- Backfill: when a person first took part — still handed over / taken, a
-- person's message, or the handover audit (given back to AI clears the rest)
UPDATE "care_conversations" c SET "humanAt" = x.at
FROM (
  SELECT c2.id, LEAST(
           c2."handoverAt", c2."agentSince",
           (SELECT min(m."createdAt") FROM "care_messages" m
            WHERE m."conversationId" = c2.id AND m.author = 'agent'),
           (SELECT min(a."createdAt") FROM "audit_logs" a
            WHERE a."resourceId" = c2.id
              AND a."eventType" IN ('care.handover', 'care.taken'))
         ) AS at
  FROM "care_conversations" c2
) x
WHERE x.id = c.id AND x.at IS NOT NULL;

-- Backfill: the AI's last search before that is the answer that did not do
UPDATE "kb_ai_queries" q SET "handedOffAt" = c."humanAt"
FROM "care_conversations" c
WHERE c."humanAt" IS NOT NULL
  AND q.id = (
    SELECT q2.id FROM "kb_ai_queries" q2
    WHERE q2."conversationRef" = c.id AND q2."createdAt" <= c."humanAt"
    ORDER BY q2."createdAt" DESC LIMIT 1
  );

-- Data Mart (`mart`, rebuilt hourly by core-service; Metabase reads it).
CREATE SCHEMA IF NOT EXISTS mart;

-- One row per AI CARE conversation; counts only, no message text.
--   result: ai_resolved (closed, AI answered, no case, no person) ·
--           case_opened · handed_over (a person took part) ·
--           no_answer (closed without any AI answer) · live (not closed)
CREATE TABLE IF NOT EXISTS mart.fact_care_conversations (
  conversation_id  TEXT PRIMARY KEY,
  company_code     TEXT NOT NULL,
  channel          TEXT NOT NULL,
  month            TEXT NOT NULL,          -- YYYY-MM (Bangkok), opened
  status           TEXT NOT NULL,
  outcome          TEXT,
  result           TEXT NOT NULL,
  identification   TEXT NOT NULL,
  customer_code    TEXT,
  handover_reason  TEXT,
  messages         INT NOT NULL,
  customer_messages INT NOT NULL,
  ai_replies       INT NOT NULL,
  ai_answered      INT NOT NULL,
  agent_replies    INT NOT NULL,
  minutes_to_person INT,
  minutes_open     INT
);
CREATE INDEX IF NOT EXISTS fact_care_conversations_company_idx
  ON mart.fact_care_conversations (company_code, month, channel);

-- KBMS: answers a handover followed no longer count as answered by AI alone
ALTER TABLE mart.fact_kb_ai_monthly
  ADD COLUMN IF NOT EXISTS handed_off INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS self_answered INT NOT NULL DEFAULT 0;
