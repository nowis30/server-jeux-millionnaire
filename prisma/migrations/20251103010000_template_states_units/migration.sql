-- AlterTable: add units and condition states to PropertyTemplate
ALTER TABLE "PropertyTemplate"
  ADD COLUMN IF NOT EXISTS "units" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "plumbingState" TEXT NOT NULL DEFAULT 'bon',
  ADD COLUMN IF NOT EXISTS "electricityState" TEXT NOT NULL DEFAULT 'bon',
  ADD COLUMN IF NOT EXISTS "roofState" TEXT NOT NULL DEFAULT 'bon';
