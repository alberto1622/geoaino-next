/**
 * Couche d'accès aux données du module Cadastre.
 * Porté depuis vericad/server/db.ts (Drizzle/MySQL → Prisma/PostgreSQL).
 *
 * Toutes les valeurs retournées sont passées par `plain()` afin d'être
 * sérialisables par les Server Actions (Prisma.Decimal → string).
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { plain } from "./serialize";

type Version = "2013" | "2026";

// ─── Communes 2013 (ancien Syscol) ───────────────────────────────────────────
export async function insertCommune2013(data: Prisma.CadCommune2013CreateInput) {
  return prisma.cadCommune2013.create({ data });
}

export async function getCommunes2013() {
  return plain(await prisma.cadCommune2013.findMany({ orderBy: { nomCommune: "asc" } }));
}

export async function getCommune2013BySyscol(syscol: string) {
  const padded = syscol.padStart(8, "0");
  return plain(await prisma.cadCommune2013.findFirst({ where: { syscolPadded: padded } }));
}

export async function countCommunes2013() {
  return prisma.cadCommune2013.count();
}

export async function getRegions2013(): Promise<string[]> {
  const rows = await prisma.cadCommune2013.findMany({
    distinct: ["region"],
    select: { region: true },
    orderBy: { region: "asc" },
  });
  return rows.map((r) => r.region).filter(Boolean) as string[];
}

export async function getCommunes2013ByRegion(region?: string) {
  return plain(
    await prisma.cadCommune2013.findMany({
      where: region ? { region } : undefined,
      orderBy: { nomCommune: "asc" },
    }),
  );
}

// ─── Communes 2026 (nouveau Syscol) ──────────────────────────────────────────
export async function insertCommune2026(data: Prisma.CadCommune2026CreateInput) {
  return prisma.cadCommune2026.create({ data });
}

export async function getCommunes2026(region?: string) {
  return plain(
    await prisma.cadCommune2026.findMany({
      where: region ? { region } : undefined,
      orderBy: { nomCommune: "asc" },
    }),
  );
}

// Version allégée sans géométries (pour listes et sélecteurs)
export async function getCommunes2026Light(region?: string) {
  return plain(
    await prisma.cadCommune2026.findMany({
      where: region ? { region } : undefined,
      select: {
        id: true,
        nomCommune: true,
        codSyscol: true,
        syscolPadded: true,
        region: true,
        departement: true,
        createdAt: true,
      },
      orderBy: { nomCommune: "asc" },
    }),
  ).map((c) => ({ ...c, syscol: c.codSyscol }));
}

export async function getCommune2026BySyscol(syscol: string) {
  const padded = syscol.padStart(8, "0");
  return plain(await prisma.cadCommune2026.findFirst({ where: { syscolPadded: padded } }));
}

/**
 * Résout le Syscol 2026 (8 chiffres) de chaque point par jointure spatiale sur
 * la géométrie des communes du référentiel 2026 (`cad_communes_2026.geom`,
 * EPSG:4326). Sert à construire les NICAD des parcelles issues d'un DXF : le
 * préfixe territorial (Syscol) n'est pas dans le dessin et doit provenir de la
 * commune 2026 qui contient la parcelle.
 *
 * Pour chaque point : commune 2026 le CONTENANT (`ST_Contains`) ; à défaut,
 * commune la plus proche dans une tolérance de 50 m (`approx = true`, pour
 * absorber les petits décalages de numérisation au bord d'une commune). Au-delà,
 * aucun Syscol n'est attribué (`syscol = null`).
 *
 * Le résultat est aligné sur l'ordre des points fournis.
 *
 * Perf (gros DXF, 100k+ points) : la résolution se fait en DEUX passes —
 *  1. contenance stricte `ST_Contains` pour TOUS les points (rapide : index
 *     GiST + `&&`), par lots pour borner la taille des requêtes ;
 *  2. repli de proximité (coûteux : `ST_DWithin` géographique + plus-proche-
 *     voisin `<->`) UNIQUEMENT pour les points non résolus en passe 1.
 * Exécuter le repli pour chaque point (l'ancienne version, via `LEFT JOIN
 * LATERAL` systématique) faisait diverger le temps de traitement → blocage.
 */
const SYSCOL_RESOLVE_CHUNK = Number(process.env.SYSCOL_RESOLVE_CHUNK || 20000);

export async function getSyscols2026ForPoints(
  points: Array<{ lng: number; lat: number }>,
): Promise<Array<{ syscol: string | null; nomCommune: string | null; approx: boolean }>> {
  if (points.length === 0) return [];

  const result: Array<{ syscol: string | null; nomCommune: string | null; approx: boolean }> =
    points.map(() => ({ syscol: null, nomCommune: null, approx: false }));

  // ── Passe 1 : contenance stricte, par lots (TOUS les points). ──────────────
  const unresolved: number[] = [];
  for (let start = 0; start < points.length; start += SYSCOL_RESOLVE_CHUNK) {
    const slice = points.slice(start, start + SYSCOL_RESOLVE_CHUNK);
    const payload = JSON.stringify(slice.map((p, k) => ({ i: start + k, lng: p.lng, lat: p.lat })));

    const rows = await prisma.$queryRaw<
      Array<{ i: number; syscol: string | null; nom: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, hit."syscolPadded" AS syscol, hit."nomCommune" AS nom
      FROM pts
      LEFT JOIN LATERAL (
        SELECT c."syscolPadded", c."nomCommune"
        FROM "cad_communes_2026" c
        WHERE c.geom IS NOT NULL AND c.geom && pts.geom AND ST_Contains(c.geom, pts.geom)
        LIMIT 1
      ) hit ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscol: r.syscol, nomCommune: r.nom, approx: false };
      else unresolved.push(i);
    }
  }

  // ── Passe 2 : repli de proximité (50 m), uniquement pour les non résolus. ──
  for (let start = 0; start < unresolved.length; start += SYSCOL_RESOLVE_CHUNK) {
    const idxSlice = unresolved.slice(start, start + SYSCOL_RESOLVE_CHUNK);
    const payload = JSON.stringify(
      idxSlice.map((i) => ({ i, lng: points[i].lng, lat: points[i].lat })),
    );

    const rows = await prisma.$queryRaw<
      Array<{ i: number; syscol: string | null; nom: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, near."syscolPadded" AS syscol, near."nomCommune" AS nom
      FROM pts
      LEFT JOIN LATERAL (
        SELECT c."syscolPadded", c."nomCommune"
        FROM "cad_communes_2026" c
        WHERE c.geom IS NOT NULL
          AND ST_DWithin(c.geom::geography, pts.geom::geography, 50)
        ORDER BY c.geom <-> pts.geom
        LIMIT 1
      ) near ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscol: r.syscol, nomCommune: r.nom, approx: true };
    }
  }

  return result;
}

/**
 * Comme `getSyscols2026ForPoints` mais renvoie aussi `region`/`departement` de la
 * commune 2026 contenante — utilisé pour renseigner la table `limite_section`
 * (une section ∈ une commune). Même stratégie : contenance stricte par lots puis
 * repli de proximité (50 m) pour les points non résolus.
 */
export async function getCommuneInfo2026ForPoints(
  points: Array<{ lng: number; lat: number }>,
): Promise<Array<{ syscol: string | null; nomCommune: string | null; region: string | null; departement: string | null; approx: boolean }>> {
  type Info = { syscol: string | null; nomCommune: string | null; region: string | null; departement: string | null; approx: boolean };
  if (points.length === 0) return [];

  const result: Info[] = points.map(() => ({
    syscol: null, nomCommune: null, region: null, departement: null, approx: false,
  }));

  type Row = { i: number; syscol: string | null; nom: string | null; region: string | null; departement: string | null };

  // ── Passe 1 : contenance stricte, par lots. ────────────────────────────────
  const unresolved: number[] = [];
  for (let start = 0; start < points.length; start += SYSCOL_RESOLVE_CHUNK) {
    const slice = points.slice(start, start + SYSCOL_RESOLVE_CHUNK);
    const payload = JSON.stringify(slice.map((p, k) => ({ i: start + k, lng: p.lng, lat: p.lat })));

    const rows = await prisma.$queryRaw<Row[]>`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, hit."syscolPadded" AS syscol, hit."nomCommune" AS nom,
             hit."region" AS region, hit."departement" AS departement
      FROM pts
      LEFT JOIN LATERAL (
        SELECT c."syscolPadded", c."nomCommune", c."region", c."departement"
        FROM "cad_communes_2026" c
        WHERE c.geom IS NOT NULL AND c.geom && pts.geom AND ST_Contains(c.geom, pts.geom)
        LIMIT 1
      ) hit ON true
    `;
    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscol: r.syscol, nomCommune: r.nom, region: r.region, departement: r.departement, approx: false };
      else unresolved.push(i);
    }
  }

  // ── Passe 2 : repli de proximité (50 m), non résolus uniquement. ───────────
  for (let start = 0; start < unresolved.length; start += SYSCOL_RESOLVE_CHUNK) {
    const idxSlice = unresolved.slice(start, start + SYSCOL_RESOLVE_CHUNK);
    const payload = JSON.stringify(idxSlice.map((i) => ({ i, lng: points[i].lng, lat: points[i].lat })));

    const rows = await prisma.$queryRaw<Row[]>`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, near."syscolPadded" AS syscol, near."nomCommune" AS nom,
             near."region" AS region, near."departement" AS departement
      FROM pts
      LEFT JOIN LATERAL (
        SELECT c."syscolPadded", c."nomCommune", c."region", c."departement"
        FROM "cad_communes_2026" c
        WHERE c.geom IS NOT NULL
          AND ST_DWithin(c.geom::geography, pts.geom::geography, 50)
        ORDER BY c.geom <-> pts.geom
        LIMIT 1
      ) near ON true
    `;
    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscol: r.syscol, nomCommune: r.nom, region: r.region, departement: r.departement, approx: true };
    }
  }

  return result;
}

export async function countCommunes2026() {
  return prisma.cadCommune2026.count();
}

export async function getRegions2026(): Promise<string[]> {
  const rows = await prisma.cadCommune2026.findMany({
    distinct: ["region"],
    select: { region: true },
    orderBy: { region: "asc" },
  });
  return rows.map((r) => r.region).filter(Boolean) as string[];
}

// ─── NICAD ───────────────────────────────────────────────────────────────────
export async function insertNicad(data: Prisma.CadNicadCreateInput) {
  return prisma.cadNicad.create({ data });
}

export async function getNicadByCode(nicad: string) {
  return plain(await prisma.cadNicad.findUnique({ where: { nicad } }));
}

export async function searchNicads(query: string, limit = 20) {
  return plain(
    await prisma.cadNicad.findMany({
      where: { nicad: { contains: query } },
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function getNicadsBySyscol(syscol: string) {
  return plain(
    await prisma.cadNicad.findMany({ where: { syscol }, orderBy: { numParcelle: "asc" } }),
  );
}

export async function updateNicadStatut(
  nicad: string,
  statut: "actif" | "bascule" | "invalide",
  nicadNouveau?: string,
) {
  return prisma.cadNicad.update({
    where: { nicad },
    data: { statut, ...(nicadNouveau ? { nicadNouveau } : {}) },
  });
}

export async function countNicads(version?: Version) {
  return prisma.cadNicad.count({ where: version ? { version } : undefined });
}

export async function countNicadsBascules() {
  return prisma.cadNicad.count({ where: { statut: "bascule" } });
}

export async function getRecentNicads(limit = 10) {
  return plain(await prisma.cadNicad.findMany({ orderBy: { createdAt: "desc" }, take: limit }));
}

// ─── Historique des basculements NICAD ───────────────────────────────────────
export async function insertNicadHistorique(data: Prisma.CadNicadHistoriqueCreateInput) {
  return prisma.cadNicadHistorique.create({ data });
}

export async function getHistoriqueByNicad(nicadCode: string) {
  return plain(
    await prisma.cadNicadHistorique.findMany({
      where: { nicadAncien: nicadCode },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function getRecentHistorique(limit = 20) {
  return plain(
    await prisma.cadNicadHistorique.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
  );
}

export async function countHistorique() {
  return prisma.cadNicadHistorique.count();
}

// ─── Journal des opérations ──────────────────────────────────────────────────
export async function insertOperation(data: Prisma.CadOperationLogCreateInput): Promise<number> {
  const created = await prisma.cadOperationLog.create({ data });
  return created.id;
}

export async function updateOperation(
  id: number,
  data: Partial<{
    statut: "succes" | "echec" | "en_cours";
    nbTraites: number;
    nbSucces: number;
    nbEchecs: number;
    details: unknown;
    fichierResultat: string;
  }>,
) {
  return prisma.cadOperationLog.update({
    where: { id },
    data: data as Prisma.CadOperationLogUpdateInput,
  });
}

export async function getRecentOperations(limit = 20) {
  return plain(await prisma.cadOperationLog.findMany({ orderBy: { createdAt: "desc" }, take: limit }));
}

export async function countOperations(type?: string) {
  return prisma.cadOperationLog.count({ where: type ? { typeOperation: type } : undefined });
}

// ─── Sections cadastrales ────────────────────────────────────────────────────
export async function insertSection(data: Prisma.CadSectionCreateInput) {
  return prisma.cadSection.create({ data });
}

export async function getSectionsByCommune(syscolCommune: string, version?: Version) {
  const padded = syscolCommune.padStart(8, "0");
  return plain(
    await prisma.cadSection.findMany({
      where: { syscolCommune: padded, ...(version ? { version } : {}) },
      orderBy: { numSection: "asc" },
    }),
  );
}

export async function getSectionByKey(syscolCommune: string, numSection: string, version: Version) {
  const padded = syscolCommune.padStart(8, "0");
  const sectionPadded = numSection.padStart(3, "0");
  return plain(
    await prisma.cadSection.findFirst({
      where: { syscolCommune: padded, numSection: sectionPadded, version },
    }),
  );
}

export async function countSections() {
  return prisma.cadSection.count();
}

// ─── Parcelles cadastrales ────────────────────────────────────────────────────
export async function insertParcelle(data: Prisma.CadParcelleCreateInput) {
  return prisma.cadParcelle.create({ data });
}

export async function getParcelleByKey(
  syscolCommune: string,
  numSection: string,
  numParcelle: string,
  version: Version,
) {
  return plain(
    await prisma.cadParcelle.findFirst({
      where: {
        syscolCommune: syscolCommune.padStart(8, "0"),
        numSection: numSection.padStart(3, "0"),
        numParcelle: numParcelle.padStart(5, "0"),
        version,
      },
    }),
  );
}

export async function getParcellesBySection(syscolCommune: string, numSection: string, version: Version) {
  return plain(
    await prisma.cadParcelle.findMany({
      where: {
        syscolCommune: syscolCommune.padStart(8, "0"),
        numSection: numSection.padStart(3, "0"),
        version,
      },
      orderBy: { numParcelle: "asc" },
    }),
  );
}

/**
 * Retourne le numéro de parcelle maximum en tenant compte des deux tables
 * (parcelles et nicads) pour garantir l'unicité de la numérotation.
 * Les numéros étant paddés à 5 chiffres, le max lexicographique == max numérique.
 */
export async function getLastNumParcelleGlobal(
  syscolCommune: string,
  numSection: string,
  version: Version,
): Promise<number> {
  const syscolPadded = syscolCommune.padStart(8, "0");
  const sectionPadded = numSection.padStart(3, "0");

  const [fromParcelles, fromNicads] = await Promise.all([
    prisma.cadParcelle.aggregate({
      _max: { numParcelle: true },
      where: { syscolCommune: syscolPadded, numSection: sectionPadded, version },
    }),
    prisma.cadNicad.aggregate({
      _max: { numParcelle: true },
      where: { syscol: syscolPadded, section: sectionPadded },
    }),
  ]);

  const n1 = parseInt(fromParcelles._max.numParcelle ?? "0", 10) || 0;
  const n2 = parseInt(fromNicads._max.numParcelle ?? "0", 10) || 0;
  return Math.max(n1, n2);
}

export async function updateParcelleNicad(
  id: number,
  nicad: string,
  statut: "actif" | "bascule" | "invalide",
) {
  return prisma.cadParcelle.update({ where: { id }, data: { nicad, statut } });
}

export async function countParcelles() {
  return prisma.cadParcelle.count();
}

// ─── Fichiers importés ───────────────────────────────────────────────────────
export async function insertFichierImporte(data: Prisma.CadFichierImporteCreateInput) {
  return prisma.cadFichierImporte.create({ data });
}

export async function getRecentFichiers(limit = 10) {
  return plain(await prisma.cadFichierImporte.findMany({ orderBy: { createdAt: "desc" }, take: limit }));
}

// ─── Géolocalisation : parcelle la plus proche de coordonnées ─────────────────
/**
 * Recherche la parcelle dont le centroïde (longitude/latitude) est le plus proche
 * des coordonnées données, dans un rayon approximatif. Filtre d'abord par bbox
 * (indexé) puis calcule la plus proche en JS.
 */
export async function getParcelleByCoords(lat: number, lng: number, radiusKm = 0.5) {
  const deltaLat = radiusKm / 111;
  const deltaLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const candidates = await prisma.cadParcelle.findMany({
    where: {
      statut: "actif",
      latitude: { gte: lat - deltaLat, lte: lat + deltaLat },
      longitude: { gte: lng - deltaLng, lte: lng + deltaLng },
    },
    take: 500,
  });

  let closest: (typeof candidates)[number] | null = null;
  let minDist = Infinity;
  for (const p of candidates) {
    if (p.latitude == null || p.longitude == null) continue;
    const plat = Number(p.latitude);
    const plng = Number(p.longitude);
    const dist = Math.sqrt(Math.pow(plat - lat, 2) + Math.pow(plng - lng, 2));
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  }
  return plain(closest);
}

/**
 * Récupère les parcelles d'une commune par code Syscol (pour la carte)
 */
export async function getParcellesBySyscol(syscol: string, limit = 2000, version?: Version) {
  return plain(
    await prisma.cadParcelle.findMany({
      where: { syscolCommune: syscol.padStart(8, "0"), ...(version ? { version } : {}) },
      take: limit,
    }),
  );
}

/**
 * Récupère les sections d'une commune avec leur géométrie (pour la carte)
 */
export async function getSectionsWithGeom(syscolCommune: string) {
  return plain(
    await prisma.cadSection.findMany({ where: { syscolCommune: syscolCommune.padStart(8, "0") } }),
  );
}

/**
 * Récupère toutes les sections avec géométrie (pour la carte globale)
 */
export async function getAllSectionsWithGeom(limit = 500) {
  return plain(
    await prisma.cadSection.findMany({ where: { geojson: { not: null } }, take: limit }),
  );
}

/**
 * Charge les parcelles dans une bounding box géographique (chargement dynamique)
 */
export async function getParcellesByBbox(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  limit = 500,
) {
  return plain(
    await prisma.cadParcelle.findMany({
      where: {
        geojson: { not: null },
        latitude: { gte: minLat, lte: maxLat },
        longitude: { gte: minLng, lte: maxLng },
      },
      take: limit,
    }),
  );
}

/**
 * Recherche une parcelle par son NICAD exact (16 caractères).
 */
export async function getParcelleByNicad(nicad: string) {
  return plain(await prisma.cadParcelle.findFirst({ where: { nicad } }));
}

/**
 * Retourne toutes les parcelles d'une commune (syscolPadded), pour export.
 */
export async function getParcellesForExport(syscol: string) {
  return plain(
    await prisma.cadParcelle.findMany({ where: { syscolCommune: syscol.padStart(8, "0") } }),
  );
}

/**
 * Retourne les parcelles de plusieurs communes (export multi-communes).
 */
export async function getParcellesMultiSyscols(syscols: string[]) {
  const padded = syscols.map((s) => s.padStart(8, "0"));
  return plain(await prisma.cadParcelle.findMany({ where: { syscolCommune: { in: padded } } }));
}

export async function countParcellesBySyscol(syscol: string): Promise<number> {
  return prisma.cadParcelle.count({ where: { syscolCommune: syscol.padStart(8, "0") } });
}

/**
 * Statistiques de parcelles par commune (syscol → count).
 */
export async function getParcellesCountBySyscol(): Promise<Record<string, number>> {
  const result = await prisma.cadParcelle.groupBy({
    by: ["syscolCommune"],
    _count: { _all: true },
  });
  return Object.fromEntries(result.map((r) => [r.syscolCommune, r._count._all]));
}

// ─── Correspondance Syscol 2013 → 2026 ──────────────────────────────────────
export async function getCorrespondances(opts?: {
  region?: string;
  departement?: string;
  statut?: "confirme" | "provisoire" | "sans_correspondance";
  typeChangement?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const where: Prisma.CadCorrespondanceWhereInput = {};
  if (opts?.region) where.region = opts.region;
  if (opts?.departement) where.departement = opts.departement;
  if (opts?.statut) where.statut = opts.statut;
  if (opts?.typeChangement) where.typeChangement = opts.typeChangement;
  if (opts?.search) {
    where.OR = [
      { nomCommune2013: { contains: opts.search, mode: "insensitive" } },
      { syscol2013: { contains: opts.search } },
      { nomCommune2026: { contains: opts.search, mode: "insensitive" } },
      { syscol2026: { contains: opts.search } },
    ];
  }
  return plain(
    await prisma.cadCorrespondance.findMany({
      where,
      orderBy: [{ region: "asc" }, { nomCommune2013: "asc" }],
      take: opts?.limit,
      skip: opts?.offset,
    }),
  );
}

export async function getCorrespondanceBySyscol2013(syscol2013: string) {
  return plain(await prisma.cadCorrespondance.findFirst({ where: { syscol2013 } }));
}

export async function upsertCorrespondance(data: {
  syscol2013: string;
  nomCommune2013?: string;
  syscol2026?: string;
  nomCommune2026?: string;
  region?: string;
  departement?: string;
  statut?: string;
  notes?: string;
}): Promise<void> {
  const existing = await prisma.cadCorrespondance.findFirst({
    where: { syscol2013: data.syscol2013 },
    select: { id: true },
  });
  if (existing) {
    await prisma.cadCorrespondance.update({
      where: { id: existing.id },
      data: {
        syscol2026: data.syscol2026,
        nomCommune2026: data.nomCommune2026,
        statut: data.statut,
        notes: data.notes,
      },
    });
  } else {
    await prisma.cadCorrespondance.create({
      data: {
        syscol2013: data.syscol2013,
        nomCommune2013: data.nomCommune2013 ?? "",
        syscol2026: data.syscol2026,
        nomCommune2026: data.nomCommune2026,
        region: data.region,
        departement: data.departement,
        statut: data.statut ?? "provisoire",
        notes: data.notes,
      },
    });
  }
}

export async function countCorrespondances(): Promise<number> {
  return prisma.cadCorrespondance.count();
}

export async function initCorrespondancesFromCommunes(): Promise<{ inserted: number; skipped: number }> {
  const [c2013, c2026] = await Promise.all([
    prisma.cadCommune2013.findMany(),
    prisma.cadCommune2026.findMany(),
  ]);
  let inserted = 0;
  let skipped = 0;
  for (const c of c2013) {
    const existing = await prisma.cadCorrespondance.findFirst({
      where: { syscol2013: c.syscolPadded },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    const nomNorm = c.nomCommune.trim().toUpperCase();
    const match2026 = c2026.find((x) => x.nomCommune.trim().toUpperCase() === nomNorm);
    await prisma.cadCorrespondance.create({
      data: {
        syscol2013: c.syscolPadded,
        nomCommune2013: c.nomCommune,
        syscol2026: match2026?.syscolPadded ?? null,
        nomCommune2026: match2026?.nomCommune ?? null,
        region: c.region ?? null,
        departement: c.departement ?? null,
        statut: match2026 ? "provisoire" : "sans_correspondance",
      },
    });
    inserted++;
  }
  return { inserted, skipped };
}

// ─── Recalcul SPATIAL de la correspondance (overlay PostGIS) ─────────────────
// Reproduit l'ETL `data/etl_verifcad/correspondance.py` : appariement par
// recouvrement de surface (en UTM 28N / EPSG:32628) + analyse de cardinalité,
// afin de qualifier le TYPE de changement entre Syscol 2013 et 2026.
const SEUIL_CONFIRME = 0.5; // recouvrement mini pour le statut "confirme"
const SEUIL_PROVISOIRE = 0.1; // recouvrement mini pour le statut "provisoire"
const SEUIL_DECOUPE = 0.15; // part mini de la commune 2013 couverte pour compter un fragment

function normNom(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

type PairRow = {
  s13: string;
  nom13: string;
  dept13: string | null;
  region13: string | null;
  s26: string;
  nom26: string;
  dept26: string | null;
  recouvr: number;
};

export async function recalculerCorrespondancesSpatiales(): Promise<{
  total: number;
  parType: Record<string, number>;
}> {
  // Toutes les paires (2013, 2026) dont les géométries se chevauchent, avec la
  // part de la commune 2013 couverte par la commune 2026 (recouvr = inter/aire13).
  // DISTINCT ON : la table 2013 peut contenir des doublons de syscolPadded
  // (imports répétés) ; on ne garde qu'une géométrie par commune pour ne pas
  // fausser le comptage des fusions.
  const pairs = await prisma.$queryRaw<PairRow[]>`
    WITH a AS (
      SELECT DISTINCT ON ("syscolPadded")
             "syscolPadded", "nomCommune", "departement", "region",
             ST_MakeValid(geom) AS geom
      FROM "cad_communes_2013" WHERE geom IS NOT NULL
      ORDER BY "syscolPadded", "id" DESC
    ),
    b AS (
      SELECT DISTINCT ON ("syscolPadded")
             "syscolPadded", "nomCommune", "departement",
             ST_MakeValid(geom) AS geom
      FROM "cad_communes_2026" WHERE geom IS NOT NULL
      ORDER BY "syscolPadded", "id" DESC
    )
    SELECT
      a."syscolPadded" AS s13,
      a."nomCommune"   AS nom13,
      a."departement"  AS dept13,
      a."region"       AS region13,
      b."syscolPadded" AS s26,
      b."nomCommune"   AS nom26,
      b."departement"  AS dept26,
      ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628))
        / NULLIF(ST_Area(ST_Transform(a.geom, 32628)), 0) AS recouvr
    FROM a
    JOIN b ON a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
    WHERE ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)) > 0
  `;

  // Liste de référence : toutes les communes 2013 (y compris sans recouvrement),
  // dédoublonnées par syscolPadded (cf. doublons d'import dans la table).
  const communes2013Raw = await prisma.cadCommune2013.findMany({
    select: { syscolPadded: true, nomCommune: true, region: true, departement: true },
  });
  const communes2013 = [
    ...new Map(communes2013Raw.map((c) => [c.syscolPadded, c])).values(),
  ];

  // Regroupement des paires par commune 2013.
  const parS13 = new Map<string, PairRow[]>();
  for (const p of pairs) {
    p.recouvr = Number(p.recouvr) || 0;
    const arr = parS13.get(p.s13) ?? [];
    arr.push(p);
    parS13.set(p.s13, arr);
  }

  // Meilleure cible 2026 par commune 2013 (recouvrement max), puis comptage des
  // communes 2013 qui visent la même 2026 (→ fusion N→1).
  const best = new Map<string, PairRow>();
  for (const [s13, arr] of parS13) {
    best.set(s13, arr.reduce((a, b) => (b.recouvr > a.recouvr ? b : a)));
  }
  const sourcesPar2026 = new Map<string, number>();
  for (const b of best.values()) {
    sourcesPar2026.set(b.s26, (sourcesPar2026.get(b.s26) ?? 0) + 1);
  }

  const parType: Record<string, number> = {};
  const data: Prisma.CadCorrespondanceCreateManyInput[] = [];

  for (const c of communes2013) {
    const s13 = c.syscolPadded;
    const b = best.get(s13);
    const rec = b?.recouvr ?? 0;
    const s26 = b?.s26 ?? null;
    const nom26 = b?.nom26 ?? null;
    const dept26 = b?.dept26 ?? null;

    const frags = (parS13.get(s13) ?? []).filter((p) => p.recouvr >= SEUIL_DECOUPE);
    const nbCibles = frags.length;
    const nbSources = s26 ? (sourcesPar2026.get(s26) ?? 0) : 0;

    const mn13 = normNom(c.nomCommune);
    const mn26 = normNom(nom26);
    const md13 = normNom(c.departement);
    const md26 = normNom(dept26);
    const nomIdentique = mn13 !== "" && mn13 === mn26;
    const deptChange = md26 !== "" && md13 !== md26;

    let statut: string;
    if (rec >= SEUIL_CONFIRME && nomIdentique) statut = "confirme";
    else if (rec >= SEUIL_PROVISOIRE) statut = "provisoire";
    else statut = "sans_correspondance";

    let typeChangement: string;
    if (rec < SEUIL_PROVISOIRE) typeChangement = "disparue";
    else if (nbCibles >= 2) typeChangement = "decoupe";
    else if (nbSources >= 2) typeChangement = "fusion";
    else if (deptChange) typeChangement = "rattachement_departement";
    else if (!nomIdentique) typeChangement = "renomme";
    else typeChangement = "inchange";
    parType[typeChangement] = (parType[typeChangement] ?? 0) + 1;

    const ciblesTxt = frags
      .sort((x, y) => y.recouvr - x.recouvr)
      .map((p) => `${p.s26}:${p.nom26} (${Math.round(p.recouvr * 100)}%)`)
      .join(" | ");

    data.push({
      syscol2013: s13,
      nomCommune2013: c.nomCommune,
      syscol2026: s26,
      nomCommune2026: nom26,
      region: c.region ?? null,
      departement: c.departement ?? null,
      departement2026: dept26,
      statut,
      typeChangement,
      nbCibles2026: nbCibles,
      nbSources2013: nbSources,
      cibles2026: ciblesTxt || null,
      notes: `recouvrement=${Math.round(rec * 100)}% / nom=${nomIdentique ? "identique" : "different"} / dept=${deptChange ? "change" : "idem"}`,
    });
  }

  // Recalcul complet : on remplace la table de correspondance.
  await prisma.$transaction([
    prisma.cadCorrespondance.deleteMany({}),
    prisma.cadCorrespondance.createMany({ data }),
  ]);

  return { total: data.length, parType };
}

// Cartes de qualification du changement pour la carte interactive.
// - parSyscol2013 : type + contexte indexés par la commune 2013 (jointure directe).
// - parSyscol2026 : type de la commune 2013 d'origine, indexé par la cible 2026
//   (best-match ; les enfants non-best d'un découpage n'y figurent pas → "nouvelle").
export type ChangementInfo = {
  type: string | null;
  departement: string | null;
  departement2026: string | null;
  nomCommune2013: string;
  nomCommune2026: string | null;
  cibles2026: string | null;
  nbCibles2026: number;
};

export async function getChangementMaps(): Promise<{
  parSyscol2013: Record<string, ChangementInfo>;
  parSyscol2026: Record<string, ChangementInfo>;
}> {
  const rows = await prisma.cadCorrespondance.findMany({
    select: {
      syscol2013: true,
      syscol2026: true,
      nomCommune2013: true,
      nomCommune2026: true,
      departement: true,
      departement2026: true,
      typeChangement: true,
      cibles2026: true,
      nbCibles2026: true,
    },
  });
  const parSyscol2013: Record<string, ChangementInfo> = {};
  const parSyscol2026: Record<string, ChangementInfo> = {};
  for (const r of rows) {
    const info: ChangementInfo = {
      type: r.typeChangement,
      departement: r.departement,
      departement2026: r.departement2026,
      nomCommune2013: r.nomCommune2013,
      nomCommune2026: r.nomCommune2026,
      cibles2026: r.cibles2026,
      nbCibles2026: r.nbCibles2026,
    };
    parSyscol2013[r.syscol2013] = info;
    if (r.syscol2026) parSyscol2026[r.syscol2026] = info;
  }
  return { parSyscol2013, parSyscol2026 };
}

// Ensemble des syscol 2026 cibles d'une correspondance "confirme" avec 2013.
// Sert à colorer les communes 2026 « sans correspondance » sur la carte.
export async function getSyscol2026Confirmes(): Promise<string[]> {
  const rows = await prisma.cadCorrespondance.findMany({
    where: { statut: "confirme", syscol2026: { not: null } },
    select: { syscol2026: true },
  });
  return [...new Set(rows.map((r) => r.syscol2026).filter((s): s is string => !!s))];
}

export async function confirmerToutesCorrespondances(): Promise<number> {
  const result = await prisma.cadCorrespondance.updateMany({
    where: { statut: "provisoire", syscol2026: { not: null } },
    data: { statut: "confirme" },
  });
  return result.count;
}

// ─── Migration en masse des NICAD (Syscol 2013 → 2026) ───────────────────────
export async function previewMigrationCommune(syscol2013: string) {
  const syscolPadded = syscol2013.padStart(8, "0");
  const [c, nbParcelles] = await Promise.all([
    prisma.cadCorrespondance.findFirst({ where: { syscol2013: syscolPadded } }),
    prisma.cadParcelle.count({
      where: { syscolCommune: syscolPadded, version: "2013", statut: "actif" },
    }),
  ]);
  return {
    syscol2013: syscolPadded,
    syscol2026: c?.syscol2026 ?? null,
    nomCommune2013: c?.nomCommune2013 ?? null,
    nomCommune2026: c?.nomCommune2026 ?? null,
    nbParcelles,
    statut: c?.statut ?? "sans_correspondance",
  };
}

export async function previewMigrationToutes(): Promise<
  Array<{
    syscol2013: string;
    syscol2026: string | null;
    nomCommune2013: string;
    nomCommune2026: string | null;
    nbParcelles: number;
    statut: string;
  }>
> {
  const rows = await prisma.$queryRaw<
    Array<{
      syscol2013: string;
      syscol2026: string | null;
      nomCommune2013: string;
      nomCommune2026: string | null;
      statut: string;
      nbParcelles: bigint;
    }>
  >`
    SELECT
      c."syscol2013",
      c."syscol2026",
      c."nomCommune2013",
      c."nomCommune2026",
      c."statut",
      COUNT(p."id") AS "nbParcelles"
    FROM "cad_correspondance_2013_2026" c
    INNER JOIN "cad_parcelles" p
      ON p."syscolCommune" = c."syscol2013"
      AND p."version" = '2013'
      AND p."statut" = 'actif'
    WHERE c."syscol2026" IS NOT NULL
      AND c."statut" <> 'sans_correspondance'
    GROUP BY c."syscol2013", c."syscol2026", c."nomCommune2013", c."nomCommune2026", c."statut"
    HAVING COUNT(p."id") > 0
    ORDER BY COUNT(p."id") DESC
  `;
  return rows.map((r) => ({
    syscol2013: String(r.syscol2013),
    syscol2026: r.syscol2026 ? String(r.syscol2026) : null,
    nomCommune2013: String(r.nomCommune2013),
    nomCommune2026: r.nomCommune2026 ? String(r.nomCommune2026) : null,
    nbParcelles: Number(r.nbParcelles),
    statut: String(r.statut),
  }));
}

/**
 * Exécute la migration en masse des NICAD pour une commune donnée.
 */
export async function executerMigrationCommune(
  syscol2013: string,
  syscol2026: string,
  operationId: number,
  userId?: string,
): Promise<{ nbMigres: number; nbEchecs: number; erreurs: string[] }> {
  const s2013 = syscol2013.padStart(8, "0");
  const s2026 = syscol2026.padStart(8, "0");

  const parcellesAMigrer = await prisma.cadParcelle.findMany({
    where: { syscolCommune: s2013, version: "2013", statut: "actif" },
  });

  let nbMigres = 0;
  let nbEchecs = 0;
  const erreurs: string[] = [];

  const BATCH = 500;
  for (let i = 0; i < parcellesAMigrer.length; i += BATCH) {
    const batch = parcellesAMigrer.slice(i, i + BATCH);
    try {
      const historiqueEntries: Prisma.CadNicadHistoriqueCreateManyInput[] = batch.map((p) => {
        const nicadAncien = p.nicad ?? `${s2013}${p.numSection}${p.numParcelle}`;
        const nicadNouveau = `${s2026}${p.numSection}${p.numParcelle}`;
        return {
          nicadAncien,
          nicadNouveau,
          syscolAncien: s2013,
          syscolNouveau: s2026,
          sectionAncienne: p.numSection,
          sectionNouvelle: p.numSection,
          communeAncienne: p.nomCommune ?? null,
          communeNouvelle: null,
          motif: `Migration en masse Syscol ${s2013} → ${s2026}`,
          operationId,
          createdBy: userId ?? null,
        };
      });

      await prisma.$transaction([
        ...batch.map((p) =>
          prisma.cadParcelle.update({
            where: { id: p.id },
            data: {
              syscolCommune: s2026,
              nicad: `${s2026}${p.numSection}${p.numParcelle}`,
              version: "2026",
              statut: "bascule",
            },
          }),
        ),
        prisma.cadNicadHistorique.createMany({ data: historiqueEntries }),
      ]);

      nbMigres += batch.length;
    } catch (err) {
      nbEchecs += batch.length;
      erreurs.push(`Lot ${i / BATCH + 1} : ${err instanceof Error ? err.message : "erreur inconnue"}`);
    }
  }

  return { nbMigres, nbEchecs, erreurs };
}

export async function executerMigrationToutes(
  operationId: number,
  userId?: string,
): Promise<{
  total: number;
  nbMigres: number;
  nbEchecs: number;
  details: Array<{ commune: string; nbMigres: number; nbEchecs: number }>;
}> {
  const corrs = await prisma.cadCorrespondance.findMany({
    where: { syscol2026: { not: null }, statut: { not: "sans_correspondance" } },
  });

  let totalMigres = 0;
  let totalEchecs = 0;
  const details: Array<{ commune: string; nbMigres: number; nbEchecs: number }> = [];

  for (const c of corrs) {
    if (!c.syscol2026) continue;
    const result = await executerMigrationCommune(c.syscol2013, c.syscol2026, operationId, userId);
    totalMigres += result.nbMigres;
    totalEchecs += result.nbEchecs;
    if (result.nbMigres > 0 || result.nbEchecs > 0) {
      details.push({ commune: c.nomCommune2013, nbMigres: result.nbMigres, nbEchecs: result.nbEchecs });
    }
  }

  return { total: corrs.length, nbMigres: totalMigres, nbEchecs: totalEchecs, details };
}
