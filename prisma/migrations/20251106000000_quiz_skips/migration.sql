-- Add column skipsLeft to QuizSession for skip feature (max 3 per session)
ALTER TABLE "QuizSession" ADD COLUMN "skipsLeft" INTEGER NOT NULL DEFAULT 3;