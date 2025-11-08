-- Add ad skip recharge tracking fields to QuizSession
ALTER TABLE "QuizSession" ADD COLUMN IF NOT EXISTS "adSkipRechargeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "QuizSession" ADD COLUMN IF NOT EXISTS "lastAdSkipAt" TIMESTAMP(3);
