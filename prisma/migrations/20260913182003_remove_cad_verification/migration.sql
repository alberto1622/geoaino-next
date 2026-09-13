-- Retrait du module "Vérifier des bornes" (OCR/PDF) : le modèle
-- CadVerification et sa table `cad_verifications` ne sont plus utilisés.
--
-- Note : `prisma migrate diff` contre la base réelle proposait aussi de
-- supprimer les index `cad_arrondissements_geom_idx` et
-- `limite_section_geom_idx` -- des index spatiaux GIST créés manuellement
-- (colonnes `Unsupported("geometry(...)")`, non exprimables dans
-- schema.prisma, donc invisibles pour l'outil de diff mais réels et
-- critiques en production, cf. desktop/src/main.ts:creerIndexSpatiaux).
-- Ces deux DROP INDEX ont été volontairement exclus de cette migration.

-- DropForeignKey
ALTER TABLE "cad_verifications" DROP CONSTRAINT "cad_verifications_userId_fkey";

-- DropTable
DROP TABLE "cad_verifications";
