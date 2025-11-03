-- DropForeignKey
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_userId_fkey";

-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "appreciationAnnual" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
ADD COLUMN     "baseMortgageRate" DOUBLE PRECISION NOT NULL DEFAULT 0.05;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
