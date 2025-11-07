-- AlterTable
ALTER TABLE "PropertyTemplate" ADD COLUMN     "floors" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "hasCommercialCenter" BOOLEAN NOT NULL DEFAULT false;
