-- IAU-DEEDS / production repair - 2026-11-18
-- Scope: ADD ONLY the missing, nullable registrationAt column to MosqueBuilding.
-- Prerequisite: verify a restorable database backup before execution on production.
-- No updates to existing rows, no timestamp backfill, no constraint/index changes.
-- Safe to rerun: IF NOT EXISTS avoids adding the column twice.

ALTER TABLE public."MosqueBuilding"
  ADD COLUMN IF NOT EXISTS "registrationAt" TIMESTAMP(3);
