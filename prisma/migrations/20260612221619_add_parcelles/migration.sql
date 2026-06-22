-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "Parcelle" (
    "id" SERIAL NOT NULL,
    "numero" TEXT,
    "denomination" TEXT,
    "autresTextes" JSONB,
    "surfaceM2" DECIMAL(20,4) NOT NULL,
    "geomGeoJson4326" JSONB NOT NULL,
    "geomHash" TEXT NOT NULL,
    "sourceFichier" TEXT NOT NULL,
    "epsg" TEXT NOT NULL DEFAULT '32628',
    "dateImport" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geom" geometry(MultiPolygon, 32628) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Parcelle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Parcelle_numero_sourceFichier_key" ON "Parcelle"("numero", "sourceFichier");

-- CreateIndex
CREATE UNIQUE INDEX "Parcelle_geomHash_sourceFichier_key" ON "Parcelle"("geomHash", "sourceFichier");

-- CreateIndex (spatial)
CREATE INDEX "Parcelle_geom_idx" ON "Parcelle" USING GIST ("geom");
