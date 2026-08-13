-- Ajoute la valeur SECTION_MISMATCH à l'enum ErrorType.
-- (Section déclarée dans le fichier source ≠ section trouvée par jointure
-- spatiale sur limite_section — cf. analyzeGeoJSON, geo-engine.ts.)
ALTER TYPE "ErrorType" ADD VALUE IF NOT EXISTS 'SECTION_MISMATCH';
