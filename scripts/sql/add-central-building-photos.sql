-- Additive only. Apply manually after confirming an encrypted backup.
-- Never run prisma db push --accept-data-loss on production.
ALTER TABLE "MosqueBuilding" ADD COLUMN IF NOT EXISTS "photos" JSONB;
