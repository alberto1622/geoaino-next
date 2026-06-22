-- Qualification du type de changement Syscol 2013 → 2026 sur la correspondance.
ALTER TABLE "cad_correspondance_2013_2026"
  ADD COLUMN "departement2026" TEXT,
  ADD COLUMN "typeChangement" TEXT,
  ADD COLUMN "nbCibles2026" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nbSources2013" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cibles2026" TEXT;
