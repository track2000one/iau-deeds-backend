-- One-time, additive migration for IAU-Deeds Vacant Lands only.
-- Apply ONLY after a verified, restorable PostgreSQL backup.
-- No existing table is altered. No DROP/DELETE/UPDATE operations are executed.
-- Fail closed if a VacantLand table or enum already exists: review manually.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $vacant_land_preflight$
BEGIN
  IF to_regclass('public."Deed"') IS NULL THEN
    RAISE EXCEPTION 'Missing public.Deed: stop. Database/schema is not the expected IAU-Deeds production database.';
  END IF;
  IF to_regclass('public."VacantLand"') IS NOT NULL THEN
    RAISE EXCEPTION 'VacantLand table already exists: stop instead of modifying existing data.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'VacantLandStatus'
  ) THEN
    RAISE EXCEPTION 'VacantLandStatus type already exists: investigate partial or prior schema setup.';
  END IF;
END;
$vacant_land_preflight$;

CREATE TYPE public."VacantLandStatus" AS ENUM (
  'DRAFT',
  'UNDER_REVIEW',
  'VERIFIED_VACANT',
  'PARTIALLY_OCCUPIED',
  'OCCUPIED',
  'ALLOCATED'
);

CREATE TABLE public."VacantLand" (
  "id"                    TEXT NOT NULL,
  "code"                  TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "campus"                TEXT NOT NULL,
  "deedId"                TEXT NOT NULL,
  "locationDescription"   TEXT,
  "approximateArea"       DECIMAL(18,2) NOT NULL,
  "verifiedVacantArea"    DECIMAL(18,2),
  "status"                public."VacantLandStatus" NOT NULL DEFAULT 'DRAFT',
  "currentUse"            TEXT,
  "allocationPurpose"     TEXT,
  "latitude"              DECIMAL(10,7),
  "longitude"             DECIMAL(10,7),
  "geometryGeoJson"       JSONB,
  "geometrySourceName"    TEXT,
  "geometryUpdatedAt"     TIMESTAMP(3),
  "geometryUpdatedByName" TEXT,
  "inspectionDate"        TIMESTAMP(3),
  "inspectionNote"        TEXT,
  "notes"                 TEXT,
  "createdById"           TEXT,
  "createdByName"         TEXT,
  "updatedById"           TEXT,
  "updatedByName"         TEXT,
  "verifiedById"          TEXT,
  "verifiedByName"        TEXT,
  "verifiedAt"            TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VacantLand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VacantLand_code_key" ON public."VacantLand" ("code");
CREATE INDEX "VacantLand_deedId_idx" ON public."VacantLand" ("deedId");
CREATE INDEX "VacantLand_campus_idx" ON public."VacantLand" ("campus");
CREATE INDEX "VacantLand_status_idx" ON public."VacantLand" ("status");
CREATE INDEX "VacantLand_createdAt_idx" ON public."VacantLand" ("createdAt");

ALTER TABLE public."VacantLand"
  ADD CONSTRAINT "VacantLand_deedId_fkey"
  FOREIGN KEY ("deedId")
  REFERENCES public."Deed" ("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

COMMIT;
