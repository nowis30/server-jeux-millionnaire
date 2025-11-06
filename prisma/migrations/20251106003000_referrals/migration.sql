-- Referral invites schema
CREATE TABLE "ReferralInvite" (
  "id" TEXT PRIMARY KEY,
  "gameId" TEXT NOT NULL,
  "inviterId" TEXT NOT NULL,
  "code" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "rewardAmount" DOUBLE PRECISION NOT NULL DEFAULT 1000000,
  "acceptedById" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP,
  CONSTRAINT "ReferralInvite_game_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReferralInvite_inviter_fkey" FOREIGN KEY ("inviterId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReferralInvite_acceptedBy_fkey" FOREIGN KEY ("acceptedById") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ReferralInvite_game_status_idx" ON "ReferralInvite" ("gameId", "status");