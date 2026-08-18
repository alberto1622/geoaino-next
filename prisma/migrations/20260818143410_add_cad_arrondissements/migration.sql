-- Référentiel arrondissements (limites administratives 2025, DGID/DTGC) —
-- géométrie propre, chargée depuis Arrondissements.shp (scripts/load-arrondissements.ts).
CREATE TABLE "cad_arrondissements" (
    "id" SERIAL NOT NULL,
    "nomArrondissement" TEXT NOT NULL,
    "region" TEXT,
    "codeRegion" TEXT,
    "departement" TEXT,
    "codeDepartement" TEXT,
    "cav" TEXT,
    "codeCav" TEXT,
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_arrondissements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cad_arrondissements_departement_idx" ON "cad_arrondissements"("departement");

CREATE INDEX "cad_arrondissements_geom_idx" ON "cad_arrondissements" USING GIST ("geom");
