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
  bNumSection: string | null;
  bCommune: string | null;
}

/** Expression SQL : GeoJSON texte → MultiPolygon 4326 valide (répare + polygones). */
const GEOM_FROM_GEOJSON = (expr: string) =>
  `ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${expr}), 4326)), 3))`;

/** Supprime le lot d'un fichier (sections + chevauchements) avant réimport. */
export async function deleteSectionsBySource(sourceFichier: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "limite_section_overlap" WHERE "sourceFichier" = ${sourceFichier}`;
  await prisma.$executeRaw`DELETE FROM "limite_section" WHERE "sourceFichier" = ${sourceFichier}`;
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

/** Sections d'un lot — ou de TOUS les lots si `sourceFichier` est null (affichage initial). */
export async function listSections(sourceFichier: string | null): Promise<SectionListItem[]> {
  const where =
    sourceFichier == null ? Prisma.empty : Prisma.sql`WHERE "sourceFichier" = ${sourceFichier}`;
  const rows = await prisma.$queryRaw<
    Array<Omit<SectionListItem, "surfaceM2"> & { surfaceM2: string | number | null }>
  >`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson"
    FROM "limite_section"
    ${where}
    ORDER BY "numSection" NULLS LAST, id
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id), surfaceM2: r.surfaceM2 == null ? null : Number(r.surfaceM2) }));
}

/** GeoJSON + lot d'une section (pour appliquer une correction géométrique). */
export async function getSection(
  id: number,
): Promise<{ geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>
  >`
    SELECT "geomGeoJson", "sourceFichier", "numSection" FROM "limite_section" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/** Met à jour la géométrie (GeoJSON + geom PostGIS) et la surface d'une section. */
export async function updateSectionGeometry(
  id: number,
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  surfaceM2: number,
): Promise<void> {
  const geojson = JSON.stringify(geomGeoJson);
  await prisma.$executeRawUnsafe(
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

/** Supprime une section (et ses chevauchements référencés). */
export async function deleteSection(id: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_overlap" WHERE "sectionAId" = ${id} OR "sectionBId" = ${id}
  `;
  await prisma.$executeRaw`DELETE FROM "limite_section" WHERE id = ${id}`;
}

/**
 * (Re)calcule les chevauchements surfaciques d'un lot. Préserve les paires
 * marquées IGNORED (non ré-insérées), remplace le reste. Appelé après l'import
 * et après chaque correction géométrique.
 */
export async function refreshOverlaps(sourceFichier: string): Promise<number> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_overlap" WHERE "sourceFichier" = ${sourceFichier} AND "status" <> 'IGNORED'
  `;
  const inserted = await prisma.$executeRaw`
    INSERT INTO "limite_section_overlap"
      ("sourceFichier","sectionAId","sectionBId","intersectionGeoJson","overlapAreaM2","status","createdAt")
    SELECT a."sourceFichier", a.id, b.id,
           ST_AsGeoJSON(ST_Intersection(a.geom, b.geom))::jsonb,
           ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)),
           'PENDING', now()
    FROM "limite_section" a
    JOIN "limite_section" b
      ON a."sourceFichier" = b."sourceFichier" AND a.id < b.id
     AND a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
    WHERE a."sourceFichier" = ${sourceFichier}
      AND ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)) > ${MIN_OVERLAP_AREA_M2}
      AND NOT EXISTS (
        SELECT 1 FROM "limite_section_overlap" o
        WHERE o."status" = 'IGNORED' AND o."sourceFichier" = a."sourceFichier"
          AND o."sectionAId" = a.id AND o."sectionBId" = b.id
      )
  `;
  return Number(inserted);
}

/** Chevauchements d'un lot — ou de TOUS les lots si `sourceFichier` est null. */
export async function listOverlaps(sourceFichier: string | null): Promise<OverlapListItem[]> {
  const where =
    sourceFichier == null ? Prisma.empty : Prisma.sql`WHERE o."sourceFichier" = ${sourceFichier}`;
  const rows = await prisma.$queryRaw<
    Array<OverlapListItem & { overlapAreaM2: string | number | null }>
  >`
    SELECT o.id, o."sectionAId", o."sectionBId", o."status",
           o."overlapAreaM2", o."intersectionGeoJson",
           a."numSection" AS "aNumSection", a."commune" AS "aCommune",
           b."numSection" AS "bNumSection", b."commune" AS "bCommune"
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
): Promise<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string }>
  >`
    SELECT id, "sectionAId", "sectionBId", "sourceFichier", "status"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), sectionAId: Number(r.sectionAId), sectionBId: Number(r.sectionBId) } : null;
}

/** Change le statut d'un chevauchement (ex. IGNORED). */
export async function setOverlapStatus(id: number, status: "PENDING" | "RESOLVED" | "IGNORED"): Promise<void> {
  await prisma.$executeRaw`UPDATE "limite_section_overlap" SET "status" = ${status} WHERE id = ${id}`;
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
