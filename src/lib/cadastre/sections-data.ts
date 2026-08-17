/**
 * sections-data.ts — accès DB (SQL brut PostGIS) pour la table `limite_section`
 * et son contrôle de chevauchements (`limite_section_overlap`).
 *
 * Tout passe par du SQL brut car la colonne `geom` est PostGIS (`Unsupported`
 * côté Prisma) et les opérations clés (insertion géométrique, self-join de
 * chevauchement, aires en mètres) sont faites en base. Un lot d'import est
 * regroupé par `sourceFichier`.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Aire minimale (m²) d'une intersection pour la considérer comme un vrai
// chevauchement surfacique (une frontière mitoyenne partagée donne une aire ~0).
const MIN_OVERLAP_AREA_M2 = Number(process.env.SECTION_OVERLAP_MIN_AREA_M2 || 1);

/** Filtre `sourceFichier` partagé par `listSections`/`listOverlaps` : un nom
 *  seul, plusieurs (sélection multiple du filtre "Lot stocké"), ou aucun
 *  (`null`/tableau vide → tous les lots). `column` porte l'alias de table le
 *  cas échéant (ex. `o."sourceFichier"` pour `listOverlaps`). */
function sourceFichierFilter(
  column: string,
  sourceFichier: string | string[] | null,
): Prisma.Sql {
  if (sourceFichier == null) return Prisma.empty;
  const list = Array.isArray(sourceFichier) ? sourceFichier : [sourceFichier];
  if (list.length === 0) return Prisma.empty;
  return list.length === 1
    ? Prisma.sql`WHERE ${Prisma.raw(column)} = ${list[0]}`
    : Prisma.sql`WHERE ${Prisma.raw(column)} = ANY(${list})`;
}

/** Filtre `sourceFichier` pour `listOverlaps` — une paire de chevauchement
 *  peut relier DEUX lots différents (`sourceFichier`/`sourceFichierB`, cf.
 *  `refreshOverlaps`) : elle doit apparaître dans la vue de L'UN OU L'AUTRE,
 *  pas seulement celle du lot de `sectionAId`. */
function overlapSourceFilter(sourceFichier: string | string[] | null): Prisma.Sql {
  if (sourceFichier == null) return Prisma.empty;
  const list = Array.isArray(sourceFichier) ? sourceFichier : [sourceFichier];
  if (list.length === 0) return Prisma.empty;
  return list.length === 1
    ? Prisma.sql`WHERE (o."sourceFichier" = ${list[0]} OR o."sourceFichierB" = ${list[0]})`
    : Prisma.sql`WHERE (o."sourceFichier" = ANY(${list}) OR o."sourceFichierB" = ANY(${list}))`;
}

/** Filtre par APPARTENANCE réelle des sections à un lot (via `limite_section`),
 *  utilisé pour les opérations dépendant des sections effectivement stockées
 *  dans ce lot (snapshot avant suppression, nettoyage) plutôt que du champ
 *  `sourceFichier`/`sourceFichierB` de l'overlap — les deux coïncident pour
 *  une paire du même lot, mais pas pour une paire croisée où seule LA MOITIÉ
 *  de la paire appartient au lot en question. */
function overlapMembershipFilter(sourceFichier: string): Prisma.Sql {
  return Prisma.sql`
    WHERE "sectionAId" IN (SELECT id FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier})
       OR "sectionBId" IN (SELECT id FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier})
  `;
}

export interface SectionInsert {
  region: string | null;
  departement: string | null;
  commune: string | null;
  syscolCommune: string | null;
  numSection: string | null;
  surfaceM2: number;
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface SectionListItem {
  id: number;
  region: string | null;
  departement: string | null;
  commune: string | null;
  syscolCommune: string | null;
  numSection: string | null;
  surfaceM2: number | null;
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  sourceFichier: string;
}

export interface OverlapListItem {
  id: number;
  sectionAId: number;
  sectionBId: number;
  status: string;
  overlapAreaM2: number | null;
  intersectionGeoJson: GeoJSON.Geometry;
  aNumSection: string | null;
  aCommune: string | null;
  aSourceFichier: string;
  bNumSection: string | null;
  bCommune: string | null;
  bSourceFichier: string;
}

/** Client Prisma OU client de transaction interactive — toutes les fonctions
 * ci-dessous acceptent l'un ou l'autre pour pouvoir s'exécuter dans la même
 * transaction que l'action qui les appelle (capture + mutation + historique
 * atomiques, cf. history.ts). */
export type Db = typeof prisma | Prisma.TransactionClient;

export interface LimiteSectionRow {
  id: number;
  region: string | null;
  departement: string | null;
  commune: string | null;
  syscolCommune: string | null;
  numSection: string | null;
  surfaceM2: number | null;
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  sourceFichier: string;
  createdAt: string;
  updatedAt: string;
}

export interface LimiteSectionOverlapRow {
  id: number;
  sourceFichier: string; // lot de sectionAId
  sourceFichierB: string; // lot de sectionBId (= sourceFichier si même lot)
  sectionAId: number;
  sectionBId: number;
  intersectionGeoJson: GeoJSON.Geometry;
  overlapAreaM2: number | null;
  status: string;
  createdAt: string;
}

type RawSectionRow = Omit<LimiteSectionRow, "surfaceM2" | "createdAt" | "updatedAt"> & {
  surfaceM2: string | number | null;
  createdAt: Date;
  updatedAt: Date;
};
function normalizeSectionRow(r: RawSectionRow): LimiteSectionRow {
  return {
    ...r,
    surfaceM2: r.surfaceM2 == null ? null : Number(r.surfaceM2),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

type RawOverlapRow = Omit<LimiteSectionOverlapRow, "overlapAreaM2" | "createdAt"> & {
  overlapAreaM2: string | number | null;
  createdAt: Date;
};
function normalizeOverlapRow(r: RawOverlapRow): LimiteSectionOverlapRow {
  return {
    ...r,
    overlapAreaM2: r.overlapAreaM2 == null ? null : Number(r.overlapAreaM2),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Ligne `limite_section` complète (toutes colonnes sauf `geom`, dérivable de
 * `geomGeoJson`) — snapshot pour l'historique, à la différence de `getSection`
 * qui ne renvoie que les champs utiles à une correction/attribution. */
export async function getSectionFull(id: number, db: Db = prisma): Promise<LimiteSectionRow | null> {
  const rows = await db.$queryRaw<RawSectionRow[]>`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson", "sourceFichier", "createdAt", "updatedAt"
    FROM "limite_section" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? normalizeSectionRow(r) : null;
}

/** Lignes `limite_section` complètes d'un lot — snapshot avant suppression du lot. */
export async function getSectionsFullBySource(sourceFichier: string, db: Db = prisma): Promise<LimiteSectionRow[]> {
  const rows = await db.$queryRaw<RawSectionRow[]>`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson", "sourceFichier", "createdAt", "updatedAt"
    FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier}
  `;
  return rows.map(normalizeSectionRow);
}

/** Chevauchements complets référençant une section — snapshot avant suppression d'une section. */
export async function getOverlapsForSection(id: number, db: Db = prisma): Promise<LimiteSectionOverlapRow[]> {
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sourceFichierB", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap" WHERE "sectionAId" = ${id} OR "sectionBId" = ${id}
  `;
  return rows.map(normalizeOverlapRow);
}

/** Chevauchements complets d'un lot — snapshot avant suppression du lot.
 *  Par APPARTENANCE réelle des sections (pas par `sourceFichier` seul) : une
 *  paire croisée avec un autre lot doit être capturée même quand ce lot est
 *  côté `sourceFichierB`, sinon elle disparaît silencieusement (non
 *  restaurable) à la suppression. */
export async function getOverlapsFullBySource(sourceFichier: string, db: Db = prisma): Promise<LimiteSectionOverlapRow[]> {
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sourceFichierB", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap" ${overlapMembershipFilter(sourceFichier)}
  `;
  return rows.map(normalizeOverlapRow);
}

/** Chevauchement complet (toutes colonnes) par id — snapshot pour l'historique
 * de correction, à la différence de `getOverlap` qui ne renvoie que les
 * champs utiles à la résolution. */
export async function getOverlapFull(id: number, db: Db = prisma): Promise<LimiteSectionOverlapRow | null> {
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sourceFichierB", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? normalizeOverlapRow(r) : null;
}

/** Réinsère (ou remet à jour) des lignes `limite_section` avec leur id
 * d'origine (restauration d'historique). `ON CONFLICT DO UPDATE` : la ligne
 * peut avoir été supprimée entre-temps (revert de `delete`) OU exister encore
 * avec des colonnes différentes (revert de `correct`/`merge`, où la section
 * cible a été modifiée mais pas supprimée) — dans les deux cas, le résultat
 * voulu est "cette ligne redevient exactement le snapshot". Idempotent : une
 * restauration rejouée deux fois réécrit deux fois les mêmes valeurs. */
export async function reinsertLimiteSections(rows: LimiteSectionRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    const geojson = JSON.stringify(r.geomGeoJson);
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section"
        (id, "region","departement","commune","syscolCommune","numSection","surfaceM2",
         "geomGeoJson","geom","sourceFichier","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,${GEOM_FROM_GEOJSON("$8")},$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        "region" = EXCLUDED."region",
        "departement" = EXCLUDED."departement",
        "commune" = EXCLUDED."commune",
        "syscolCommune" = EXCLUDED."syscolCommune",
        "numSection" = EXCLUDED."numSection",
        "surfaceM2" = EXCLUDED."surfaceM2",
        "geomGeoJson" = EXCLUDED."geomGeoJson",
        "geom" = EXCLUDED."geom",
        "sourceFichier" = EXCLUDED."sourceFichier",
        "updatedAt" = EXCLUDED."updatedAt"
      `,
      r.id, r.region, r.departement, r.commune, r.syscolCommune, r.numSection, r.surfaceM2,
      geojson, r.sourceFichier, new Date(r.createdAt), new Date(r.updatedAt),
    );
  }
}

/** Réinsère (ou remet à jour) des lignes `limite_section_overlap` avec leur id
 * d'origine — même raisonnement upsert que `reinsertLimiteSections` : le
 * revert d'une action `ignore` cible un overlap dont seul le `status` a
 * changé, la ligne existe toujours. */
export async function reinsertLimiteSectionOverlaps(rows: LimiteSectionOverlapRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section_overlap"
        (id, "sourceFichier","sourceFichierB","sectionAId","sectionBId","intersectionGeoJson","overlapAreaM2","status","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        "sourceFichier" = EXCLUDED."sourceFichier",
        "sourceFichierB" = EXCLUDED."sourceFichierB",
        "sectionAId" = EXCLUDED."sectionAId",
        "sectionBId" = EXCLUDED."sectionBId",
        "intersectionGeoJson" = EXCLUDED."intersectionGeoJson",
        "overlapAreaM2" = EXCLUDED."overlapAreaM2",
        "status" = EXCLUDED."status"
      `,
      r.id, r.sourceFichier, r.sourceFichierB, r.sectionAId, r.sectionBId, JSON.stringify(r.intersectionGeoJson), r.overlapAreaM2, r.status, new Date(r.createdAt),
    );
  }
}

/** Expression SQL : GeoJSON texte → MultiPolygon 4326 valide (répare + polygones). */
const GEOM_FROM_GEOJSON = (expr: string) =>
  `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${expr}), 4326)), 3))`;

/** Supprime le lot d'un fichier (sections + chevauchements) avant réimport,
 * ou par l'action de suppression manuelle (cf. delete/route.ts). Le nettoyage
 * des chevauchements se fait par APPARTENANCE réelle des sections (pas par
 * `sourceFichier` seul) : un chevauchement croisé avec un autre lot a ses
 * sections des deux côtés de la relation, et doit disparaître dès que L'UNE
 * des deux est supprimée — sinon la ligne reste orpheline, référençant un id
 * de section qui n'existe plus. DOIT s'exécuter AVANT la suppression des
 * sections elles-mêmes (la sous-requête d'appartenance en dépend). */
export async function deleteSectionsBySource(sourceFichier: string, db: Db = prisma): Promise<void> {
  await db.$executeRaw`DELETE FROM "limite_section_overlap" ${overlapMembershipFilter(sourceFichier)}`;
  await db.$executeRaw`
    DELETE FROM "limite_section_admin_mismatch"
    WHERE "sectionId" IN (SELECT id FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier})
  `;
  await db.$executeRaw`DELETE FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier}`;
}

/** Insère un lot de sections (géométrie 4326 dérivée du GeoJSON) → ids créés. */
export async function insertLimiteSections(
  sourceFichier: string,
  sections: SectionInsert[],
): Promise<number[]> {
  if (sections.length === 0) return [];
  const payload = JSON.stringify(
    sections.map((s) => ({
      region: s.region,
      departement: s.departement,
      commune: s.commune,
      syscol: s.syscolCommune,
      numSection: s.numSection,
      surfaceM2: s.surfaceM2,
      geojson: s.geomGeoJson,
    })),
  );

  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `
    INSERT INTO "limite_section"
      ("region","departement","commune","syscolCommune","numSection","surfaceM2",
       "geomGeoJson","geom","sourceFichier","createdAt","updatedAt")
    SELECT e->>'region', e->>'departement', e->>'commune', e->>'syscol', e->>'numSection',
           NULLIF(e->>'surfaceM2','')::numeric,
           (e->'geojson')::jsonb,
           ${GEOM_FROM_GEOJSON("e->>'geojson'")},
           $2, now(), now()
    FROM json_array_elements($1::json) AS e
    RETURNING id
    `,
    payload,
    sourceFichier,
  );
  return rows.map((r) => Number(r.id));
}

/** Sections d'un/plusieurs lot(s) — ou de TOUS les lots si `sourceFichier` est
 *  `null`/vide (affichage initial, ou case "Tous les lots" du filtre). */
export async function listSections(
  sourceFichier: string | string[] | null,
): Promise<SectionListItem[]> {
  const where = sourceFichierFilter('"sourceFichier"', sourceFichier);
  const rows = await prisma.$queryRaw<
    Array<Omit<SectionListItem, "surfaceM2"> & { surfaceM2: string | number | null }>
  >`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson", "sourceFichier"
    FROM "limite_section"
    ${where}
    ORDER BY "numSection" NULLS LAST, id
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id), surfaceM2: r.surfaceM2 == null ? null : Number(r.surfaceM2) }));
}

/** GeoJSON + lot d'une section (pour appliquer une correction géométrique ou attribuer un numéro). */
export async function getSection(
  id: number,
  db: Db = prisma,
): Promise<{
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  sourceFichier: string;
  numSection: string | null;
  syscolCommune: string | null;
  commune: string | null;
} | null> {
  const rows = await db.$queryRaw<
    Array<{
      geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      sourceFichier: string;
      numSection: string | null;
      syscolCommune: string | null;
      commune: string | null;
    }>
  >`
    SELECT "geomGeoJson", "sourceFichier", "numSection", "syscolCommune", "commune"
    FROM "limite_section" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/** Sections par ids (fusion manuelle) — renvoyées dans l'ordre demandé. */
export async function getSectionsByIds(
  ids: number[],
  db: Db = prisma,
): Promise<Array<{ id: number; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<
    Array<{ id: number | bigint; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>
  >`
    SELECT id, "geomGeoJson", "sourceFichier", "numSection"
    FROM "limite_section" WHERE id IN (${Prisma.join(ids)})
  `;
  const byId = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r != null);
}

/** Lignes `limite_section` complètes par ids (fusion manuelle) — snapshot avant
 * fusion, ordre préservé selon `ids` comme `getSectionsByIds`, à la différence
 * que toutes les colonnes sont renvoyées (nécessaire pour restaurer). */
export async function getSectionsFullByIds(ids: number[], db: Db = prisma): Promise<LimiteSectionRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<RawSectionRow[]>`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson", "sourceFichier", "createdAt", "updatedAt"
    FROM "limite_section" WHERE id IN (${Prisma.join(ids)})
  `;
  const byId = new Map(rows.map((r) => [r.id, normalizeSectionRow(r)]));
  return ids.map((id) => byId.get(id)).filter((r): r is LimiteSectionRow => r != null);
}

/** Chevauchements complets référençant au moins une des sections données —
 * snapshot avant fusion/correction touchant plusieurs sections à la fois. */
export async function getOverlapsForSections(ids: number[], db: Db = prisma): Promise<LimiteSectionOverlapRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sourceFichierB", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap"
    WHERE "sectionAId" IN (${Prisma.join(ids)}) OR "sectionBId" IN (${Prisma.join(ids)})
  `;
  return rows.map(normalizeOverlapRow);
}

/** Met à jour la géométrie (GeoJSON + geom PostGIS) et la surface d'une section. */
export async function updateSectionGeometry(
  id: number,
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  surfaceM2: number,
  db: Db = prisma,
): Promise<void> {
  const geojson = JSON.stringify(geomGeoJson);
  await db.$executeRawUnsafe(
    `
    UPDATE "limite_section"
    SET "geomGeoJson" = $2::jsonb,
        "geom" = ${GEOM_FROM_GEOJSON("$2")},
        "surfaceM2" = $3,
        "updatedAt" = now()
    WHERE id = $1
    `,
    id,
    geojson,
    surfaceM2,
  );
}

/** Supprime une section (et ses chevauchements/mismatchs administratifs
 * référencés). Accepte un client de transaction pour s'exécuter atomiquement
 * avec sa capture d'historique. */
export async function deleteSection(id: number, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    DELETE FROM "limite_section_overlap" WHERE "sectionAId" = ${id} OR "sectionBId" = ${id}
  `;
  await db.$executeRaw`DELETE FROM "limite_section_admin_mismatch" WHERE "sectionId" = ${id}`;
  await db.$executeRaw`DELETE FROM "limite_section" WHERE id = ${id}`;
}

/**
 * Cherche une AUTRE section de la même commune portant déjà ce numéro —
 * l'unicité du numéro de section n'est vraie que PAR COMMUNE (cf.
 * build-sections.ts, clé de dissolution (syscol, numéro)). Sans commune
 * résolue (`syscolCommune` null), aucun contrôle n'est possible.
 */
export async function findSectionNumeroConflict(
  syscolCommune: string | null,
  numSection: string,
  excludeId: number,
  db: Db = prisma,
): Promise<{ id: number; commune: string | null } | null> {
  if (!syscolCommune) return null;
  const rows = await db.$queryRaw<Array<{ id: number | bigint; commune: string | null }>>`
    SELECT id, "commune" FROM "limite_section"
    WHERE "syscolCommune" = ${syscolCommune} AND "numSection" = ${numSection} AND id <> ${excludeId}
    LIMIT 1
  `;
  const r = rows[0];
  return r ? { id: Number(r.id), commune: r.commune } : null;
}

/** Attribue un numéro à une section (n'affecte pas la géométrie ni les
 * chevauchements). `numSection: null` remet la section à l'état "sans
 * numéro" — utilisé par le revert d'une action `numero`. */
export async function updateSectionNumero(id: number, numSection: string | null, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE "limite_section" SET "numSection" = ${numSection}, "updatedAt" = now() WHERE id = ${id}
  `;
}

/**
 * (Re)calcule les chevauchements surfaciques impliquant ce lot — CONTRE
 * TOUTES les sections déjà stockées, pas seulement celles du même lot : deux
 * lots chargés séparément (re-découpage administratif, fichiers voisins,
 * doublon d'import) peuvent se chevaucher géographiquement sans jamais
 * partager `sourceFichier`, une incohérence auparavant invisible. Préserve
 * les paires marquées IGNORED (non ré-insérées), remplace le reste. Appelé
 * après l'import (donc dès le CHARGEMENT d'un nouveau lot) et après chaque
 * correction géométrique.
 *
 * Le JOIN n'ancre QUE le côté `a` sur `sourceFichier` (index dédié) ; `b`
 * parcourt tout `limite_section`, filtré par l'index spatial GiST sur `geom`
 * (`a.geom && b.geom`) — même stratégie déjà validée pour la détection
 * `section_mismatch` (§19, CONCEPTS-TRAITEMENT-DXF.md). Une paire du MÊME lot
 * est trouvée deux fois (a/b interchangeables) ; `LEAST`/`GREATEST` normalise
 * l'identité de la paire et `DISTINCT ON` élimine le doublon — une paire
 * croisée avec un AUTRE lot n'est trouvée qu'une fois (seul un côté peut
 * matcher `a."sourceFichier" = sourceFichier`), donc jamais dupliquée.
 *
 * Le nettoyage préalable (DELETE) et la préservation des IGNORED portent sur
 * la PAIRE de sections (pas sur `sourceFichier` seul) : un rafraîchissement
 * déclenché par L'AUTRE lot d'une paire croisée doit retrouver/écraser la
 * même ligne, jamais en créer une seconde.
 */
export async function refreshOverlaps(sourceFichier: string): Promise<number> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_overlap"
    WHERE ("sourceFichier" = ${sourceFichier} OR "sourceFichierB" = ${sourceFichier})
      AND "status" <> 'IGNORED'
  `;
  const inserted = await prisma.$executeRaw`
    INSERT INTO "limite_section_overlap"
      ("sourceFichier","sourceFichierB","sectionAId","sectionBId","intersectionGeoJson","overlapAreaM2","status","createdAt")
    SELECT DISTINCT ON (least_id, greatest_id)
      lot_least, lot_greatest, least_id, greatest_id, geojson, area, 'PENDING', now()
    FROM (
      SELECT
        CASE WHEN a.id < b.id THEN a."sourceFichier" ELSE b."sourceFichier" END AS lot_least,
        CASE WHEN a.id < b.id THEN b."sourceFichier" ELSE a."sourceFichier" END AS lot_greatest,
        LEAST(a.id, b.id) AS least_id,
        GREATEST(a.id, b.id) AS greatest_id,
        ST_AsGeoJSON(ST_Intersection(a.geom, b.geom))::jsonb AS geojson,
        ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)) AS area
      FROM "limite_section" a
      JOIN "limite_section" b
        ON a.id <> b.id AND a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
      WHERE a."sourceFichier" = ${sourceFichier}
        AND ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)) > ${MIN_OVERLAP_AREA_M2}
    ) pairs
    WHERE NOT EXISTS (
      SELECT 1 FROM "limite_section_overlap" o
      WHERE o."status" = 'IGNORED'
        AND o."sectionAId" = pairs.least_id AND o."sectionBId" = pairs.greatest_id
    )
    ORDER BY least_id, greatest_id
  `;
  return Number(inserted);
}

/** Chevauchements d'un/plusieurs lot(s) — ou de TOUS les lots si `sourceFichier` est null/vide. */
export async function listOverlaps(
  sourceFichier: string | string[] | null,
): Promise<OverlapListItem[]> {
  const where = overlapSourceFilter(sourceFichier);
  const rows = await prisma.$queryRaw<
    Array<OverlapListItem & { overlapAreaM2: string | number | null }>
  >`
    SELECT o.id, o."sectionAId", o."sectionBId", o."status",
           o."overlapAreaM2", o."intersectionGeoJson",
           a."numSection" AS "aNumSection", a."commune" AS "aCommune", a."sourceFichier" AS "aSourceFichier",
           b."numSection" AS "bNumSection", b."commune" AS "bCommune", b."sourceFichier" AS "bSourceFichier"
    FROM "limite_section_overlap" o
    JOIN "limite_section" a ON a.id = o."sectionAId"
    JOIN "limite_section" b ON b.id = o."sectionBId"
    ${where}
    ORDER BY o."status" = 'PENDING' DESC, o."overlapAreaM2" DESC NULLS LAST, o.id
  `;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    sectionAId: Number(r.sectionAId),
    sectionBId: Number(r.sectionBId),
    overlapAreaM2: r.overlapAreaM2 == null ? null : Number(r.overlapAreaM2),
  }));
}

/** Chevauchement seul (résolution d'une correction). */
export async function getOverlap(
  id: number,
  db: Db = prisma,
): Promise<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string } | null> {
  const rows = await db.$queryRaw<
    Array<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string }>
  >`
    SELECT id, "sectionAId", "sectionBId", "sourceFichier", "status"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), sectionAId: Number(r.sectionAId), sectionBId: Number(r.sectionBId) } : null;
}

/** Change le statut d'un chevauchement (ex. IGNORED). */
export async function setOverlapStatus(
  id: number,
  status: "PENDING" | "RESOLVED" | "IGNORED",
  db: Db = prisma,
): Promise<void> {
  await db.$executeRaw`UPDATE "limite_section_overlap" SET "status" = ${status} WHERE id = ${id}`;
}

export interface SectionGeoItem {
  id: number;
  numSection: string | null;
  commune: string | null;
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  /** Point garanti à l'intérieur du polygone (ST_PointOnSurface) — ancre de l'étiquette. */
  labelPoint: GeoJSON.Point | null;
}

/**
 * Toutes les sections stockées (tous lots) avec leur point d'étiquette, pour
 * l'affichage des limites + numéros de section sur la carte d'analyse.
 */
export async function listSectionsGeo(): Promise<SectionGeoItem[]> {
  const rows = await prisma.$queryRaw<
    Array<Omit<SectionGeoItem, "id"> & { id: number | bigint }>
  >`
    SELECT id, "numSection", "commune", "geomGeoJson",
           ST_AsGeoJSON(ST_PointOnSurface("geom"))::jsonb AS "labelPoint"
    FROM "limite_section"
    ORDER BY "numSection" NULLS LAST, id
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export interface SectionBatch {
  sourceFichier: string;
  nbSections: number;
  nbOverlapsPending: number;
  updatedAt: string;
}

/** Lots de sections déjà stockés (pour réafficher au chargement de la page). */
export async function listSectionBatches(): Promise<SectionBatch[]> {
  const rows = await prisma.$queryRaw<
    Array<{ sourceFichier: string; nbSections: number | bigint; nbOverlapsPending: number | bigint; updatedAt: Date }>
  >`
    SELECT s."sourceFichier" AS "sourceFichier",
           count(*)::int AS "nbSections",
           COALESCE((
             SELECT count(*)::int FROM "limite_section_overlap" o
             WHERE o."sourceFichier" = s."sourceFichier" AND o."status" = 'PENDING'
           ), 0) AS "nbOverlapsPending",
           max(s."updatedAt") AS "updatedAt"
    FROM "limite_section" s
    GROUP BY s."sourceFichier"
    ORDER BY max(s."updatedAt") DESC
  `;
  return rows.map((r) => ({
    sourceFichier: r.sourceFichier,
    nbSections: Number(r.nbSections),
    nbOverlapsPending: Number(r.nbOverlapsPending),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }));
}

/** Nombre de sections d'un lot (garde-fou / stats). */
export async function countSections(sourceFichier: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier}
  `;
  return Number(rows[0]?.n ?? 0);
}

// Taille de lot pour la résolution spatiale section — même volumétrie que
// `SYSCOL_RESOLVE_CHUNK` (data.ts), configurable indépendamment au besoin.
const SECTION_RESOLVE_CHUNK = Number(process.env.SECTION_RESOLVE_CHUNK || 20000);

/**
 * Résout, pour chaque point (lng/lat, EPSG:4326), la section `limite_section`
 * le CONTENANT (`ST_Contains`) ; à défaut, la section la plus proche dans une
 * tolérance de 50 m (`approx = true`), même logique que
 * `getSyscols2026ForPoints` (`data.ts`) pour les communes 2026. Renvoie
 * syscol ET numéro de section en une seule jointure (contrairement à la
 * jointure commune, `limite_section` porte les deux). Au-delà de la
 * tolérance, aucune section n'est attribuée (tous les champs `null`).
 */
export async function getSectionsForPoints(
  points: Array<{ lng: number; lat: number }>,
  db: Db = prisma,
): Promise<Array<{ syscolCommune: string | null; numSection: string | null; commune: string | null; approx: boolean }>> {
  if (points.length === 0) return [];

  const result: Array<{ syscolCommune: string | null; numSection: string | null; commune: string | null; approx: boolean }> =
    points.map(() => ({ syscolCommune: null, numSection: null, commune: null, approx: false }));

  // Table vide (bootstrapping : aucune section importée pour la zone) → rien
  // ne résoudra jamais, ni en passe 1 ni en passe 2. Court-circuite les deux
  // pour éviter à chaque point le ST_DWithin + tri par proximité de la passe
  // 2, coûteux et voué à l'échec. Ne traite QUE ce cas total (0 ligne) : une
  // fois l'index GiST en place (cf. migration 20260812130000), la couverture
  // partielle reste bon marché et n'a pas besoin de ce court-circuit.
  const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "limite_section"`;
  if (Number(count) === 0) return result;

  // ── Passe 1 : contenance stricte, par lots (TOUS les points). ──────────────
  const unresolved: number[] = [];
  for (let start = 0; start < points.length; start += SECTION_RESOLVE_CHUNK) {
    const slice = points.slice(start, start + SECTION_RESOLVE_CHUNK);
    const payload = JSON.stringify(slice.map((p, k) => ({ i: start + k, lng: p.lng, lat: p.lat })));

    const rows = await db.$queryRaw<
      Array<{ i: number; syscol: string | null; numSection: string | null; commune: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, hit."syscolCommune" AS syscol, hit."numSection" AS "numSection", hit."commune" AS commune
      FROM pts
      LEFT JOIN LATERAL (
        SELECT s."syscolCommune", s."numSection", s."commune"
        FROM "limite_section" s
        WHERE s.geom IS NOT NULL AND s.geom && pts.geom AND ST_Contains(s.geom, pts.geom)
        LIMIT 1
      ) hit ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscolCommune: r.syscol, numSection: r.numSection, commune: r.commune, approx: false };
      else unresolved.push(i);
    }
  }

  // ── Passe 2 : repli de proximité (50 m), uniquement pour les non résolus. ──
  for (let start = 0; start < unresolved.length; start += SECTION_RESOLVE_CHUNK) {
    const idxSlice = unresolved.slice(start, start + SECTION_RESOLVE_CHUNK);
    const payload = JSON.stringify(
      idxSlice.map((i) => ({ i, lng: points[i].lng, lat: points[i].lat })),
    );

    const rows = await db.$queryRaw<
      Array<{ i: number; syscol: string | null; numSection: string | null; commune: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, near."syscolCommune" AS syscol, near."numSection" AS "numSection", near."commune" AS commune
      FROM pts
      LEFT JOIN LATERAL (
        SELECT s."syscolCommune", s."numSection", s."commune"
        FROM "limite_section" s
        WHERE s.geom IS NOT NULL
          AND ST_DWithin(s.geom::geography, pts.geom::geography, 50)
        ORDER BY s.geom <-> pts.geom
        LIMIT 1
      ) near ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscolCommune: r.syscol, numSection: r.numSection, commune: r.commune, approx: true };
    }
  }

  return result;
}
