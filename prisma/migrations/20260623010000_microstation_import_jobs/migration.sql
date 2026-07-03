-- Recadrage Phase 1 : le traitement DXF/DGN relève du domaine « Microstation »
-- (cœur geoaino → produit une Analysis), pas du module verifcad. On retire donc
-- les ajouts faits par erreur sur cad_parcelles / cad_import_jobs et on crée la
-- table de jobs correctement nommée (import_jobs) avec un lien vers Analysis.
-- ───────────────────────────────────────────────────────────────────────────

-- 1) Revert des ajouts verifcad (cad_parcelles) — sans perte de données métier.
DROP INDEX IF EXISTS "cad_parcelles_geomHash_sourceJobId_key";
DROP INDEX IF EXISTS "cad_parcelles_properties_idx";
DROP INDEX IF EXISTS "cad_parcelles_sourceJobId_idx";
ALTER TABLE "cad_parcelles"
    DROP COLUMN IF EXISTS "properties",
    DROP COLUMN IF EXISTS "geomHash",
    DROP COLUMN IF EXISTS "sourceJobId";

DROP TABLE IF EXISTS "cad_import_jobs";

-- 2) Table des jobs de traitement Microstation asynchrone.
CREATE TABLE "import_jobs" (
    "id" SERIAL NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalBuilt" INTEGER NOT NULL DEFAULT 0,
    "analysisId" INTEGER,
    "report" JSONB,
    "error" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");
