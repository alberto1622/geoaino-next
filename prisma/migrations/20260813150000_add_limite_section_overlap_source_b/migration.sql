-- Ajoute "sourceFichierB" à limite_section_overlap : jusqu'ici une paire ne
-- pouvait être enregistrée qu'à l'intérieur d'un même lot (sourceFichier
-- portait le lot des DEUX sections). refreshOverlaps détecte désormais aussi
-- les chevauchements entre le lot chargé et TOUS les lots déjà stockés —
-- "sourceFichier" reste le lot de sectionAId, "sourceFichierB" celui de
-- sectionBId (identiques pour une paire du même lot, cf. sections-data.ts).
ALTER TABLE "limite_section_overlap" ADD COLUMN "sourceFichierB" TEXT;
UPDATE "limite_section_overlap" SET "sourceFichierB" = "sourceFichier" WHERE "sourceFichierB" IS NULL;
ALTER TABLE "limite_section_overlap" ALTER COLUMN "sourceFichierB" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "limite_section_overlap_sourceFichierB_idx" ON "limite_section_overlap" ("sourceFichierB");
