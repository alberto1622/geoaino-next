-- Variante « simple » du mappage des calques : l'utilisateur confirme le
-- rattachement calque → classe DGID avant le lancement de l'import. Le choix
-- validé est persisté sur le job et rejoué par l'ingestion.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "import_jobs" ADD COLUMN "layerMapping" JSONB;
