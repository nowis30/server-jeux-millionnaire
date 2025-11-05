-- CreateTable
CREATE TABLE "QuizQuestionSeen" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizQuestionSeen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizQuestionSeen_playerId_idx" ON "QuizQuestionSeen"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizQuestionSeen_playerId_questionId_key" ON "QuizQuestionSeen"("playerId", "questionId");

-- AddForeignKey
ALTER TABLE "QuizQuestionSeen" ADD CONSTRAINT "QuizQuestionSeen_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizQuestionSeen" ADD CONSTRAINT "QuizQuestionSeen_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
