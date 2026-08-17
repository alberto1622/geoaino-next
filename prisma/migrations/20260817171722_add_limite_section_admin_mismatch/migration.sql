-- Table de contrôle des chevauchements entre `limite_section` et les limites
-- administratives (communes/départements/régions, `cad_communes_2026`) —
-- une section censée tenir entièrement dans SA commune déclarée peut en
-- réalité déborder dans une autre unité administrative (souvent une section
-- fusionnée à tort par-delà une limite mitoyenne absente du DXF source).
-- Calquée sur "limite_section_overlap".
CREATE TABLE "limite_section_admin_mismatch" (
    "id" SERIAL NOT NULL,
    "sourceFichier" TEXT NOT NULL,
    "sectionId" INTEGER NOT NULL,
    "adminLevel" TEXT NOT NULL,
    "adminNom" TEXT NOT NULL,
    "intersectionGeoJson" JSONB NOT NULL,
    "overlapAreaM2" DECIMAL(20,4),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "limite_section_admin_mismatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "limite_section_admin_mismatch_sourceFichier_status_idx" ON "limite_section_admin_mismatch"("sourceFichier", "status");

CREATE INDEX "limite_section_admin_mismatch_sectionId_idx" ON "limite_section_admin_mismatch"("sectionId");
