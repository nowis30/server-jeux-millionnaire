-- Ajout des champs d'inflation au modèle Game
ALTER TABLE "Game" ADD COLUMN "inflationAnnual" DOUBLE PRECISION NOT NULL DEFAULT 0.02;
ALTER TABLE "Game" ADD COLUMN "inflationIndex" DOUBLE PRECISION NOT NULL DEFAULT 1;
