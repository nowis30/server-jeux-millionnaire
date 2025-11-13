-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "dragBestTimeMs" INTEGER,
ADD COLUMN     "dragEngineLevel" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "dragLastRewardAt" TIMESTAMP(3),
ADD COLUMN     "dragLastRunAt" TIMESTAMP(3),
ADD COLUMN     "dragStage" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "dragTransmissionLevel" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "DragRun" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "elapsedMs" INTEGER NOT NULL,
    "win" BOOLEAN NOT NULL,
    "perfectShifts" INTEGER NOT NULL DEFAULT 0,
    "reward" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grantedReward" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deviceInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DragRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DragRun_gameId_playerId_createdAt_idx" ON "DragRun"("gameId", "playerId", "createdAt");

-- AddForeignKey
ALTER TABLE "DragRun" ADD CONSTRAINT "DragRun_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DragRun" ADD CONSTRAINT "DragRun_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
