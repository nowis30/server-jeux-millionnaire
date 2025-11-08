-- Migration: add player cumulative gains fields (pari, quiz, market realized, dividends)
-- Safe add columns if not exist (PostgreSQL requires conditional checks via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Player' AND column_name='cumulativePariGain') THEN
    ALTER TABLE "Player" ADD COLUMN "cumulativePariGain" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Player' AND column_name='cumulativeQuizGain') THEN
    ALTER TABLE "Player" ADD COLUMN "cumulativeQuizGain" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Player' AND column_name='cumulativeMarketRealized') THEN
    ALTER TABLE "Player" ADD COLUMN "cumulativeMarketRealized" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Player' AND column_name='cumulativeMarketDividends') THEN
    ALTER TABLE "Player" ADD COLUMN "cumulativeMarketDividends" DOUBLE PRECISION NOT NULL DEFAULT 0;
  END IF;
END $$;
