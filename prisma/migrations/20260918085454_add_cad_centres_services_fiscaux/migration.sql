-- Référentiel centres de services fiscaux (CSF, limites administratives
-- 2023, DGID) — géométrie propre, chargée depuis Limites_CSF_2023.shp
-- (scripts/load-limites-csf.ts).
CREATE TABLE "cad_centres_services_fiscaux" (
    "id" SERIAL NOT NULL,
    "nomCsf" TEXT NOT NULL,
    "region" TEXT,
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_centres_services_fiscaux_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cad_centres_services_fiscaux_region_idx" ON "cad_centres_services_fiscaux"("region");

CREATE INDEX "cad_centres_services_fiscaux_geom_idx" ON "cad_centres_services_fiscaux" USING GIST ("geom");
