-- CreateTable
CREATE TABLE "cad_communes_2013" (
    "id" SERIAL NOT NULL,
    "nomCommune" TEXT NOT NULL,
    "syscol" TEXT NOT NULL,
    "syscolPadded" TEXT NOT NULL,
    "region" TEXT,
    "departement" TEXT,
    "cav" TEXT,
    "superficie" DECIMAL(15,6),
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_communes_2013_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_communes_2026" (
    "id" SERIAL NOT NULL,
    "nomCommune" TEXT NOT NULL,
    "region" TEXT,
    "departement" TEXT,
    "cav" TEXT,
    "arrondissement" TEXT,
    "codSyscol" TEXT NOT NULL,
    "syscolPadded" TEXT NOT NULL,
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_communes_2026_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_sections" (
    "id" SERIAL NOT NULL,
    "syscolCommune" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "numSection" TEXT NOT NULL,
    "nomSection" TEXT,
    "nomCommune" TEXT,
    "region" TEXT,
    "departement" TEXT,
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "cad_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_parcelles" (
    "id" SERIAL NOT NULL,
    "syscolCommune" TEXT NOT NULL,
    "numSection" TEXT NOT NULL,
    "numParcelle" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "nicad" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'sans_nicad',
    "nomProprietaire" TEXT,
    "superficie" DECIMAL(12,4),
    "longitude" DECIMAL(15,8),
    "latitude" DECIMAL(15,8),
    "geojson" TEXT,
    "geom" geometry(MultiPolygon, 4326),
    "nomCommune" TEXT,
    "region" TEXT,
    "departement" TEXT,
    "numLot" TEXT,
    "titreParce" TEXT,
    "typeDocFon" TEXT,
    "natJuri" TEXT,
    "typeDestin" TEXT,
    "catOcup" TEXT,
    "quartier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "cad_parcelles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_nicads" (
    "id" SERIAL NOT NULL,
    "nicad" TEXT NOT NULL,
    "syscol" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT '001',
    "numParcelle" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'actif',
    "nomCommune" TEXT,
    "region" TEXT,
    "departement" TEXT,
    "longitude" DECIMAL(15,8),
    "latitude" DECIMAL(15,8),
    "nicadNouveau" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "cad_nicads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_nicad_historique" (
    "id" SERIAL NOT NULL,
    "nicadAncien" TEXT NOT NULL,
    "nicadNouveau" TEXT NOT NULL,
    "syscolAncien" TEXT NOT NULL,
    "syscolNouveau" TEXT NOT NULL,
    "sectionAncienne" TEXT,
    "sectionNouvelle" TEXT,
    "communeAncienne" TEXT,
    "communeNouvelle" TEXT,
    "motif" TEXT,
    "operationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "cad_nicad_historique_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_operations_log" (
    "id" SERIAL NOT NULL,
    "typeOperation" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_cours',
    "description" TEXT,
    "nbTraites" INTEGER NOT NULL DEFAULT 0,
    "nbSucces" INTEGER NOT NULL DEFAULT 0,
    "nbEchecs" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "fichierSource" TEXT,
    "fichierResultat" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "cad_operations_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_correspondance_2013_2026" (
    "id" SERIAL NOT NULL,
    "syscol2013" TEXT NOT NULL,
    "nomCommune2013" TEXT NOT NULL,
    "syscol2026" TEXT,
    "nomCommune2026" TEXT,
    "region" TEXT,
    "departement" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'provisoire',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "cad_correspondance_2013_2026_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cad_fichiers_importes" (
    "id" SERIAL NOT NULL,
    "nomFichier" TEXT NOT NULL,
    "typeFichier" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "urlS3" TEXT,
    "nbEntites" INTEGER NOT NULL DEFAULT 0,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "erreur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "cad_fichiers_importes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cad_communes_2013_syscolPadded_idx" ON "cad_communes_2013"("syscolPadded");

-- CreateIndex
CREATE INDEX "cad_communes_2026_syscolPadded_idx" ON "cad_communes_2026"("syscolPadded");

-- CreateIndex
CREATE INDEX "cad_sections_syscolCommune_numSection_version_idx" ON "cad_sections"("syscolCommune", "numSection", "version");

-- CreateIndex
CREATE INDEX "cad_parcelles_syscolCommune_numSection_version_idx" ON "cad_parcelles"("syscolCommune", "numSection", "version");

-- CreateIndex
CREATE INDEX "cad_parcelles_nicad_idx" ON "cad_parcelles"("nicad");

-- CreateIndex
CREATE UNIQUE INDEX "cad_nicads_nicad_key" ON "cad_nicads"("nicad");

-- CreateIndex
CREATE INDEX "cad_nicads_version_idx" ON "cad_nicads"("version");

-- CreateIndex
CREATE INDEX "cad_nicads_statut_idx" ON "cad_nicads"("statut");

-- CreateIndex
CREATE INDEX "cad_operations_log_typeOperation_idx" ON "cad_operations_log"("typeOperation");

-- CreateIndex
CREATE INDEX "cad_correspondance_2013_2026_syscol2013_idx" ON "cad_correspondance_2013_2026"("syscol2013");

-- Index spatiaux PostGIS (GIST) sur les colonnes geom
CREATE INDEX "cad_communes_2013_geom_idx" ON "cad_communes_2013" USING GIST ("geom");
CREATE INDEX "cad_communes_2026_geom_idx" ON "cad_communes_2026" USING GIST ("geom");
CREATE INDEX "cad_sections_geom_idx" ON "cad_sections" USING GIST ("geom");
CREATE INDEX "cad_parcelles_geom_idx" ON "cad_parcelles" USING GIST ("geom");
