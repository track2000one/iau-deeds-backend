-- Targeted additive schema for STAGING review only.
-- Do not run on Production without a verified backup and explicit approval.
-- Does not alter existing deeds, buildings, inspections, or vacant-land records.
CREATE TABLE IF NOT EXISTS "SurveyTeamAssignment" (
  "code" TEXT NOT NULL PRIMARY KEY,
  "fullName" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "campusCode" TEXT,
  "campusName" TEXT,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "notes" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SurveyTeamAssignment_userId_key" ON "SurveyTeamAssignment"("userId");
CREATE INDEX IF NOT EXISTS "SurveyTeamAssignment_campusCode_idx" ON "SurveyTeamAssignment"("campusCode");
CREATE INDEX IF NOT EXISTS "SurveyTeamAssignment_status_idx" ON "SurveyTeamAssignment"("status");
