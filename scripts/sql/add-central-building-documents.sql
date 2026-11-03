-- Staging first: additive, non-destructive metadata column for private documents.
-- Back up PostgreSQL and apply before deploying backend code generated from updated Prisma schema.
ALTER TABLE "MosqueBuilding" ADD COLUMN IF NOT EXISTS "documents" JSONB;
