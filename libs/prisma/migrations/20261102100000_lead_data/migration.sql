-- lead.research: what the agent found, written by Vuvagent (nullable — existing rows stay null)
ALTER TABLE "leads" ADD COLUMN "data" JSONB;
