/**
 * admin-mismatch-data.ts — accès DB (SQL brut PostGIS) pour le contrôle de
 * superposition entre `limite_section` et les limites ADMINISTRATIVES
 * (commune/département/région, `cad_communes_2026`) — table
 * `limite_section_admin_mismatch`.
 *
 * Calqué sur le contrôle de chevauchements section↔section
 * (`refreshOverlaps`/`listOverlaps`, sections-data.ts), mais compare chaque
 * section à un référentiel EXTERNE (communes 2026) plutôt qu'à elle-même :
 * une section est censée tenir entièrement dans SA commune déclarée
 * (`syscolCommune`) ; si sa géométrie déborde dans une AUTRE commune, la part
 * qui déborde est un signal fort d'une section fusionnée à tort par-delà une
 * limite mitoyenne absente du DXF source (cf. § « sections fusionnées/
 * disparues », docs/CONCEPTS-TRAITEMENT-DXF.md — c'est exactement ce qui a
 * produit les collisions de NICAD entre communes détectées par
 * `geo-engine.ts`).
 *
 * Département et région n'ont pas de géométrie propre dans `cad_communes_2026`
 * (seules les communes en portent) — la géométrie de chaque département/
 * région est dissoute À LA VOLÉE (`ST_Union` groupé par attribut, même
 * stratégie que `admin-boundaries.ts` pour l'affichage carte) dans une CTE,
 * recalculée à chaque rafraîchissement. Un débordement de commune peut donc
 * aussi apparaître en département/région SEULEMENT si l'unité voisine
 * appartient à un autre département/région — les trois niveaux sont
 * indépendants (un débordement vers une commune du MÊME département n'est
 * jamais un mismatch de département).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Db } from "./sections-data";

// Aire minimale (m²) d'une intersection pour la considérer comme un vrai
// débordement (une frontière mitoyenne partagée donne une aire ~0), même
// principe que MIN_OVERLAP_AREA_M2 (sections-data.ts).
const MIN_ADMIN_MISMATCH_AREA_M2 = Number(process.env.SECTION_ADMIN_MISMATCH_MIN_AREA_M2 || 1);

export type AdminLevel = "commune" | "departement" | "region";

export interface LimiteSectionAdminMismatchRow {
  id: number;
  sourceFichier: string;
  sectionId: number;
  adminLevel: string;
  adminNom: string;
  intersectionGeoJson: GeoJSON.Geometry;
  overlapAreaM2: number | null;
  status: string;
  createdAt: string;
}

export interface AdminMismatchListItem {
  id: number;
  sectionId: number;
  adminLevel: string;
  adminNom: string;
  status: string;
  overlapAreaM2: number | null;
  intersectionGeoJson: GeoJSON.Geometry;
  sectionNumSection: string | null;
  sectionCommune: string | null;
  sectionDepartement: string | null;
  sectionRegion: string | null;
  sectionSourceFichier: string;
}

type RawMismatchRow = Omit<LimiteSectionAdminMismatchRow, "overlapAreaM2" | "createdAt"> & {
  overlapAreaM2: string | number | null;
  createdAt: Date;
};
function normalizeMismatchRow(r: RawMismatchRow): LimiteSectionAdminMismatchRow {
  return {
    ...r,
    overlapAreaM2: r.overlapAreaM2 == null ? null : Number(r.overlapAreaM2),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Filtre `sourceFichier` pour `listAdminMismatches` — même forme que
 *  `sourceFichierFilter` (sections-data.ts), dupliqué ici pour ne pas
 *  exporter un détail interne d'un autre module. */
function sourceFilter(sourceFichier: string | string[] | null): Prisma.Sql {
  if (sourceFichier == null) return Prisma.empty;
  const list = Array.isArray(sourceFichier) ? sourceFichier : [sourceFichier];
  if (list.length === 0) return Prisma.empty;
  return list.length === 1
    ? Prisma.sql`WHERE m."sourceFichier" = ${list[0]}`
    : Prisma.sql`WHERE m."sourceFichier" = ANY(${list})`;
}

/**
 * (Re)calcule les débordements administratifs impliquant ce lot, aux trois
 * niveaux (commune/département/région) — remplace tout ce qui n'est pas
 * `IGNORED` pour ce lot, préserve les lignes `IGNORED` (non ré-insérées).
 * Appelé après l'import d'un lot de sections ET après toute correction
 * modifiant la géométrie d'une section de ce lot (chevauchement
 * section↔section OU mismatch administratif — les deux peuvent se recouper).
 *
 * Niveau commune : jointure DIRECTE sur `cad_communes_2026` (géométrie
 * propre). Niveaux département/région : dissolution à la volée par CTE
 * (`ST_Union` groupé), coût O(nb communes) une fois par appel — acceptable en
 * tâche de fond (même volumétrie que `refreshOverlaps`), le référentiel
 * communal du Sénégal restant de l'ordre de la centaine de lignes.
 */
export async function refreshAdminMismatches(sourceFichier: string): Promise<number> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_admin_mismatch"
    WHERE "sourceFichier" = ${sourceFichier} AND "status" <> 'IGNORED'
  `;

  const communeInserted = await prisma.$executeRaw`
    INSERT INTO "limite_section_admin_mismatch"
      ("sourceFichier","sectionId","adminLevel","adminNom","intersectionGeoJson","overlapAreaM2","status","createdAt")
    SELECT s."sourceFichier", s.id, 'commune', c."nomCommune",
           ST_AsGeoJSON(ST_Intersection(s.geom, c.geom))::jsonb,
           ST_Area(ST_Transform(ST_Intersection(s.geom, c.geom), 32628)),
           'PENDING', now()
    FROM "limite_section" s
    JOIN "cad_communes_2026" c
      ON c.geom && s.geom AND ST_Intersects(c.geom, s.geom)
     AND c."syscolPadded" IS DISTINCT FROM s."syscolCommune"
    WHERE s."sourceFichier" = ${sourceFichier}
      AND s."syscolCommune" IS NOT NULL
      AND ST_Area(ST_Transform(ST_Intersection(s.geom, c.geom), 32628)) > ${MIN_ADMIN_MISMATCH_AREA_M2}
      AND NOT EXISTS (
        SELECT 1 FROM "limite_section_admin_mismatch" mi
        WHERE mi."status" = 'IGNORED' AND mi."sectionId" = s.id
          AND mi."adminLevel" = 'commune' AND mi."adminNom" = c."nomCommune"
      )
  `;

  const deptInserted = await prisma.$executeRaw`
    INSERT INTO "limite_section_admin_mismatch"
      ("sourceFichier","sectionId","adminLevel","adminNom","intersectionGeoJson","overlapAreaM2","status","createdAt")
    WITH dept AS (
      SELECT "departement", ST_Union(geom) AS geom
      FROM "cad_communes_2026"
      WHERE "departement" IS NOT NULL AND geom IS NOT NULL
      GROUP BY "departement"
    )
    SELECT s."sourceFichier", s.id, 'departement', d."departement",
           ST_AsGeoJSON(ST_Intersection(s.geom, d.geom))::jsonb,
           ST_Area(ST_Transform(ST_Intersection(s.geom, d.geom), 32628)),
           'PENDING', now()
    FROM "limite_section" s
    JOIN dept d
      ON d.geom && s.geom AND ST_Intersects(d.geom, s.geom)
     AND d."departement" IS DISTINCT FROM s."departement"
    WHERE s."sourceFichier" = ${sourceFichier}
      AND s."departement" IS NOT NULL
      AND ST_Area(ST_Transform(ST_Intersection(s.geom, d.geom), 32628)) > ${MIN_ADMIN_MISMATCH_AREA_M2}
      AND NOT EXISTS (
        SELECT 1 FROM "limite_section_admin_mismatch" mi
        WHERE mi."status" = 'IGNORED' AND mi."sectionId" = s.id
          AND mi."adminLevel" = 'departement' AND mi."adminNom" = d."departement"
      )
  `;

  const regionInserted = await prisma.$executeRaw`
    INSERT INTO "limite_section_admin_mismatch"
      ("sourceFichier","sectionId","adminLevel","adminNom","intersectionGeoJson","overlapAreaM2","status","createdAt")
    WITH reg AS (
      SELECT "region", ST_Union(geom) AS geom
      FROM "cad_communes_2026"
      WHERE "region" IS NOT NULL AND geom IS NOT NULL
      GROUP BY "region"
    )
    SELECT s."sourceFichier", s.id, 'region', r."region",
           ST_AsGeoJSON(ST_Intersection(s.geom, r.geom))::jsonb,
           ST_Area(ST_Transform(ST_Intersection(s.geom, r.geom), 32628)),
           'PENDING', now()
    FROM "limite_section" s
    JOIN reg r
      ON r.geom && s.geom AND ST_Intersects(r.geom, s.geom)
     AND r."region" IS DISTINCT FROM s."region"
    WHERE s."sourceFichier" = ${sourceFichier}
      AND s."region" IS NOT NULL
      AND ST_Area(ST_Transform(ST_Intersection(s.geom, r.geom), 32628)) > ${MIN_ADMIN_MISMATCH_AREA_M2}
      AND NOT EXISTS (
        SELECT 1 FROM "limite_section_admin_mismatch" mi
        WHERE mi."status" = 'IGNORED' AND mi."sectionId" = s.id
          AND mi."adminLevel" = 'region' AND mi."adminNom" = r."region"
      )
  `;

  return Number(communeInserted) + Number(deptInserted) + Number(regionInserted);
}

/** Débordements administratifs d'un/plusieurs lot(s) — ou de TOUS les lots si `sourceFichier` est null/vide. */
export async function listAdminMismatches(
  sourceFichier: string | string[] | null,
): Promise<AdminMismatchListItem[]> {
  const where = sourceFilter(sourceFichier);
  const rows = await prisma.$queryRaw<
    Array<AdminMismatchListItem & { overlapAreaM2: string | number | null }>
  >`
    SELECT m.id, m."sectionId", m."adminLevel", m."adminNom", m."status",
           m."overlapAreaM2", m."intersectionGeoJson",
           s."numSection" AS "sectionNumSection", s."commune" AS "sectionCommune",
           s."departement" AS "sectionDepartement", s."region" AS "sectionRegion",
           s."sourceFichier" AS "sectionSourceFichier"
    FROM "limite_section_admin_mismatch" m
    JOIN "limite_section" s ON s.id = m."sectionId"
    ${where}
    ORDER BY m."status" = 'PENDING' DESC, m."overlapAreaM2" DESC NULLS LAST, m.id
  `;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    sectionId: Number(r.sectionId),
    overlapAreaM2: r.overlapAreaM2 == null ? null : Number(r.overlapAreaM2),
  }));
}

/** Mismatch administratif seul (résolution d'une correction). */
export async function getAdminMismatch(
  id: number,
  db: Db = prisma,
): Promise<{ id: number; sectionId: number; sourceFichier: string; adminLevel: string; status: string } | null> {
  const rows = await db.$queryRaw<
    Array<{ id: number; sectionId: number; sourceFichier: string; adminLevel: string; status: string }>
  >`
    SELECT id, "sectionId", "sourceFichier", "adminLevel", "status"
    FROM "limite_section_admin_mismatch" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), sectionId: Number(r.sectionId) } : null;
}

/** Mismatch administratif complet (toutes colonnes) — snapshot pour l'historique. */
export async function getAdminMismatchFull(id: number, db: Db = prisma): Promise<LimiteSectionAdminMismatchRow | null> {
  const rows = await db.$queryRaw<RawMismatchRow[]>`
    SELECT id, "sourceFichier", "sectionId", "adminLevel", "adminNom",
           "intersectionGeoJson", "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_admin_mismatch" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? normalizeMismatchRow(r) : null;
}

/** Mismatchs administratifs complets référençant une section — snapshot avant correction/suppression d'une section. */
export async function getAdminMismatchesForSection(id: number, db: Db = prisma): Promise<LimiteSectionAdminMismatchRow[]> {
  const rows = await db.$queryRaw<RawMismatchRow[]>`
    SELECT id, "sourceFichier", "sectionId", "adminLevel", "adminNom",
           "intersectionGeoJson", "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_admin_mismatch" WHERE "sectionId" = ${id}
  `;
  return rows.map(normalizeMismatchRow);
}

/** Mismatchs administratifs complets référençant au moins une des sections
 *  données — snapshot avant fusion touchant plusieurs sections à la fois
 *  (même contrat que `getOverlapsForSections`, sections-data.ts). */
export async function getAdminMismatchesForSections(ids: number[], db: Db = prisma): Promise<LimiteSectionAdminMismatchRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<RawMismatchRow[]>`
    SELECT id, "sourceFichier", "sectionId", "adminLevel", "adminNom",
           "intersectionGeoJson", "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_admin_mismatch" WHERE "sectionId" IN (${Prisma.join(ids)})
  `;
  return rows.map(normalizeMismatchRow);
}

/** Mismatchs administratifs complets d'un lot (par appartenance RÉELLE des
 *  sections, comme `getOverlapsFullBySource`) — snapshot avant suppression du lot. */
export async function getAdminMismatchesFullBySource(sourceFichier: string, db: Db = prisma): Promise<LimiteSectionAdminMismatchRow[]> {
  const rows = await db.$queryRaw<RawMismatchRow[]>`
    SELECT m.id, m."sourceFichier", m."sectionId", m."adminLevel", m."adminNom",
           m."intersectionGeoJson", m."overlapAreaM2", m."status", m."createdAt"
    FROM "limite_section_admin_mismatch" m
    WHERE m."sectionId" IN (SELECT id FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier})
  `;
  return rows.map(normalizeMismatchRow);
}

/** Change le statut d'un mismatch administratif (ex. IGNORED). */
export async function setAdminMismatchStatus(
  id: number,
  status: "PENDING" | "RESOLVED" | "IGNORED",
  db: Db = prisma,
): Promise<void> {
  await db.$executeRaw`UPDATE "limite_section_admin_mismatch" SET "status" = ${status} WHERE id = ${id}`;
}

/** Géométrie EXACTE (non simplifiée, contrairement à `admin-boundaries.ts`
 *  qui simplifie pour l'affichage carte) de la commune 2026 portant ce
 *  Syscol — référence pour découper une section qui déborde de sa commune
 *  déclarée. */
export async function getCommuneGeom(
  syscolPadded: string,
  db: Db = prisma,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
  const rows = await db.$queryRaw<Array<{ geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null }>>`
    SELECT ST_AsGeoJSON(geom)::jsonb AS geom
    FROM "cad_communes_2026" WHERE "syscolPadded" = ${syscolPadded} AND geom IS NOT NULL
    LIMIT 1
  `;
  return rows[0]?.geom ?? null;
}

/** Réinsère (ou remet à jour) des lignes `limite_section_admin_mismatch` avec
 *  leur id d'origine (restauration d'historique) — même stratégie upsert que
 *  `reinsertLimiteSectionOverlaps` (sections-data.ts). */
export async function reinsertLimiteSectionAdminMismatches(rows: LimiteSectionAdminMismatchRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section_admin_mismatch"
        (id, "sourceFichier","sectionId","adminLevel","adminNom","intersectionGeoJson","overlapAreaM2","status","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        "sourceFichier" = EXCLUDED."sourceFichier",
        "sectionId" = EXCLUDED."sectionId",
        "adminLevel" = EXCLUDED."adminLevel",
        "adminNom" = EXCLUDED."adminNom",
        "intersectionGeoJson" = EXCLUDED."intersectionGeoJson",
        "overlapAreaM2" = EXCLUDED."overlapAreaM2",
        "status" = EXCLUDED."status"
      `,
      r.id, r.sourceFichier, r.sectionId, r.adminLevel, r.adminNom,
      JSON.stringify(r.intersectionGeoJson), r.overlapAreaM2, r.status, new Date(r.createdAt),
    );
  }
}
