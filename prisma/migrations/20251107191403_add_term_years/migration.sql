-- AlterTable
ALTER TABLE "PropertyHolding" ADD COLUMN     "termYears" INTEGER NOT NULL DEFAULT 25;

-- AlterTable
ALTER TABLE "ReferralInvite" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "acceptedAt" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Prize" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountValue" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "awardedAt" TIMESTAMP(3) NOT NULL,
    "winnerId" TEXT,
    "winnerEmail" TEXT,
    "gameId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prize_pkey" PRIMARY KEY ("id")
);

-- RenameForeignKey
ALTER TABLE "ReferralInvite" RENAME CONSTRAINT "ReferralInvite_acceptedBy_fkey" TO "ReferralInvite_acceptedById_fkey";

-- RenameForeignKey
ALTER TABLE "ReferralInvite" RENAME CONSTRAINT "ReferralInvite_game_fkey" TO "ReferralInvite_gameId_fkey";

-- RenameForeignKey
ALTER TABLE "ReferralInvite" RENAME CONSTRAINT "ReferralInvite_inviter_fkey" TO "ReferralInvite_inviterId_fkey";

-- AddForeignKey
ALTER TABLE "Prize" ADD CONSTRAINT "Prize_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ReferralInvite_game_status_idx" RENAME TO "ReferralInvite_gameId_status_idx";
