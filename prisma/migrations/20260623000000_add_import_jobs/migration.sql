-- Phase 1 : import en lot des fichiers CAO (DXF/DGN) vers cad_parcelles
-- ───────────────────────────────────────────────────────────────────────────

-- CreateTable : job d'import asynchrone (suivi d'avancement)
CREATE TABLE "cad_import_jobs" (
    "id" SERIAL NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalBuilt" INTEGER NOT NULL DEFAULT 0,
    "totalInserted" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "error" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cad_import_jobs_status_idx" ON "cad_import_jobs"("status");

-- AlterTable : provenance + payload variable + idempotence sur cad_parcelles
ALTER TABLE "cad_parcelles"
    ADD COLUMN "properties" JSONB,
    ADD COLUMN "geomHash" TEXT,
    ADD COLUMN "sourceJobId" INTEGER;

-- CreateIndex : filtrer/supprimer les parcelles d'un import donné
CREATE INDEX "cad_parcelles_sourceJobId_idx" ON "cad_parcelles"("sourceJobId");

-- CreateIndex (GIN) : recherche sur les attributs variables (champs différents
-- selon le fichier source) stockés dans le payload JSONB.
CREATE INDEX "cad_parcelles_properties_idx" ON "cad_parcelles" USING GIN ("properties");

-- CreateIndex (unique partiel) : idempotence d'un job — une même géométrie
-- (geomHash) n'est insérée qu'une fois par job (sourceJobId). Partiel pour ne
-- pas contraindre les parcelles cadastrales historiques (geomHash/sourceJobId NULL).
CREATE UNIQUE INDEX "cad_parcelles_geomHash_sourceJobId_key"
    ON "cad_parcelles"("geomHash", "sourceJobId")
    WHERE "geomHash" IS NOT NULL AND "sourceJobId" IS NOT NULL;
