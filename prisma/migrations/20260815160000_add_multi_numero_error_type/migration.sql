-- Ajoute la valeur MULTI_NUMERO à l'enum ErrorType.
-- (Limite de parcelle portant PLUSIEURS numéros de parcelle distincts —
-- fusion probable de parcelles voisines — cf. analyzeGeoJSON, geo-engine.ts.)
ALTER TYPE "ErrorType" ADD VALUE IF NOT EXISTS 'MULTI_NUMERO';
