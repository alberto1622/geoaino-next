-- Module « Vérifier des bornes » (/cadastre/plan-verif, porté de cadex-next) :
-- une CadVerification par contrôle de parcelle reconstruite depuis un tableau
-- de bornes X/Y. `geom` en SQL brut (colonne PostGIS non générable par Prisma),
-- comme `cad_parcelles.geom` (cf. 20260818143410_add_cad_arrondissements).

CREATE TABLE "cad_verifications" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "nicad" TEXT,
    "crsSource" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bornes" JSONB NOT NULL,
    "superficieCalculee" DECIMAL(20,4) NOT NULL,
    "superficieDeclaree" DECIMAL(20,4),
    "perimetreM" DECIMAL(20,4) NOT NULL,
    "tolerancePct" DECIMAL(6,3) NOT NULL,
    "tolerancePlancher" DECIMAL(10,3) NOT NULL,
    "verdict" TEXT NOT NULL,
    "anomalies" JSONB NOT NULL,
    "geom" geometry(Polygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_verifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cad_verifications_userId_idx" ON "cad_verifications"("userId");

CREATE INDEX "cad_verifications_nicad_idx" ON "cad_verifications"("nicad");

CREATE INDEX "cad_verifications_geom_idx" ON "cad_verifications" USING GIST ("geom");

ALTER TABLE "cad_verifications" ADD CONSTRAINT "cad_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
