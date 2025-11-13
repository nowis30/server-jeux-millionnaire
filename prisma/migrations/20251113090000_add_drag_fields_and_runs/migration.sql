-- Migration: add drag fields to Player and create DragRun table
-- Safe-guards (IF NOT EXISTS) are used to avoid failures if partially applied earlier.

-- 1) Alter Player to add drag-related columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragStage'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragStage" INTEGER NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragLastRewardAt'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragLastRewardAt" TIMESTAMP(3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragLastRunAt'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragLastRunAt" TIMESTAMP(3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragBestTimeMs'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragBestTimeMs" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragEngineLevel'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragEngineLevel" INTEGER NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Player' AND column_name = 'dragTransmissionLevel'
  ) THEN
    ALTER TABLE "Player" ADD COLUMN "dragTransmissionLevel" INTEGER NOT NULL DEFAULT 1;
  END IF;
END $$;

-- 2) Create DragRun table if not exists
CREATE TABLE IF NOT EXISTS "DragRun" (
  "id" TEXT PRIMARY KEY,
  "playerId" TEXT NOT NULL,
  "gameId" TEXT NOT NULL,
  "stage" INTEGER NOT NULL,
  "elapsedMs" INTEGER NOT NULL,
  "win" BOOLEAN NOT NULL,
  "perfectShifts" INTEGER NOT NULL DEFAULT 0,
  "reward" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "grantedReward" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "deviceInfo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3) Add indexes and foreign keys for DragRun (idempotent)
DO $$
BEGIN
  -- Index on (gameId, playerId, createdAt)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'DragRun' AND indexname = 'DragRun_gameId_playerId_createdAt_idx'
  ) THEN
    CREATE INDEX "DragRun_gameId_playerId_createdAt_idx" ON "DragRun" ("gameId", "playerId", "createdAt");
  END IF;

  -- FK to Player
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'DragRun' AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'DragRun_playerId_fkey'
  ) THEN
    ALTER TABLE "DragRun" ADD CONSTRAINT "DragRun_playerId_fkey"
      FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- FK to Game
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'DragRun' AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'DragRun_gameId_fkey'
  ) THEN
    ALTER TABLE "DragRun" ADD CONSTRAINT "DragRun_gameId_fkey"
      FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
