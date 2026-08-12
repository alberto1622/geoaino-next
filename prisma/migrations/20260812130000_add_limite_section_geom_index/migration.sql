-- Index spatial PostGIS (GIST) sur limite_section.geom — absent depuis la
-- création de la table, contrairement à cad_communes_2013/2026, cad_sections
-- et cad_parcelles (cf. 20260618144113_add_cadastre_module/migration.sql) qui
-- en ont un depuis l'origine. Sans lui, les jointures spatiales de
-- getSectionsForPoints (src/lib/cadastre/sections-data.ts) — ST_Contains,
-- ST_DWithin, tri par proximité <-> — dégénèrent en scan séquentiel complet.
CREATE INDEX "limite_section_geom_idx" ON "limite_section" USING GIST ("geom");
