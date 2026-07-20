/**
 * build-sections.ts — orchestration DB de la table `limite_section`.
 *
 * Prend le résultat d'ingestion DXF (sections extraites de `limites_sections` +
 * numéro, cf. parcelle-ingestion.ts), résout la commune de CHAQUE fragment par
 * jointure spatiale sur `cad_communes_2026`, fusionne les fragments d'une même
 * section — clé (commune, numéro) : un numéro de section n'est unique que dans
 * sa commune —, persiste les lignes puis contrôle les chevauchements. Calqué sur
 * `assign-nicad-2026.ts` (étape DB isolée de l'ingestion géométrique pure).
 */
import * as turf from "@turf/turf";
import type { DxfIngestionResult } from "@/lib/parcelle-ingestion";
import { getCommuneInfo2026ForPoints } from "./data";
import {
  deleteSectionsBySource,
  insertLimiteSections,
  refreshOverlaps,
  type SectionInsert,
} from "./sections-data";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// Aire maximale (m²) d'un polygone SANS numéro de section pour être traité en
// RÉSIDU : trou ou lamelle découpé dans une vraie section par le noding — il
// est fusionné dans la section qui le contient/borde (celle qui partage le
// plus de frontière). Sans hôte trouvé, il est écarté. Une vraie section
// couvre plusieurs hectares : un « numéro manquant » légitime reste au-dessus
// du seuil et n'est jamais traité en résidu. Ne s'applique JAMAIS aux
// polygones numérotés.
const MIN_UNNUMBERED_AREA_M2 = Number(process.env.SECTION_MIN_AREA_SANS_NUMERO_M2 || 10_000);

export interface BuildSectionsResult {
  sourceFichier: string;
  nbSections: number;
  nbSansCommune: number;
  nbOverlaps: number;
  /** Contours d'ensemble sans numéro écartés (contenaient des sections numérotées). */
  nbEnveloppesEcartees: number;
  /** Résidus sans numéro fusionnés dans leur section hôte. */
  nbResidusFusionnes: number;
  /** Résidus sans numéro écartés (aucune section hôte trouvée). */
  nbResidusEcartes: number;
}

/** Agrège des fragments en un (Multi)Polygon par concaténation d'anneaux (aucune perte). */
function combineFragments(geoms: PolyGeom[]): PolyGeom {
  const polys: GeoJSON.Position[][][] = [];
  for (const g of geoms) {
    if (g.type === "Polygon") polys.push(g.coordinates);
    else polys.push(...g.coordinates);
  }
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/**
 * Dissout les fragments d'un même groupe (union topologique) SANS jamais perdre
 * de fragment : si l'union échoue (géométrie invalide, anneaux Microstation
 * auto-intersectants tolérés en amont), on retombe sur la concaténation des
 * anneaux. L'ancien comportement (« on garde l'accumulateur courant ») jetait
 * silencieusement le fragment fautif → sections amputées/disparues.
 */
function dissolveGroup(geoms: PolyGeom[]): PolyGeom {
  if (geoms.length === 1) return geoms[0];
  try {
    let acc = turf.feature(geoms[0]) as GeoJSON.Feature<PolyGeom>;
    for (let i = 1; i < geoms.length; i++) {
      const u = turf.union(turf.featureCollection([acc, turf.feature(geoms[i])]));
      if (!u?.geometry) throw new Error("union vide");
      acc = u as GeoJSON.Feature<PolyGeom>;
    }
    return acc.geometry;
  } catch {
    return combineFragments(geoms);
  }
}

function areaM2(geom: PolyGeom): number {
  try {
    return turf.area(turf.feature(geom));
  } catch {
    return 0;
  }
}

/**
 * Absorbe les résidus dans leur section hôte (mutation de `rows`). Hôte = la
 * ligne dont l'intersection avec le résidu bufferisé de 1 m est la plus grande
 * (≈ frontière partagée la plus longue — départage les lamelles bordées par
 * deux sections). L'union comble aussi les TROUS : un résidu logé dans un trou
 * de la section n'est pas « contenu » au sens point-dans-polygone (le trou est
 * exclu), mais son buffer chevauche l'anneau — d'où le test par buffer.
 */
function absorbResidus(
  rows: SectionInsert[],
  residus: PolyGeom[],
): { nbFusionnes: number; nbEcartes: number } {
  let nbFusionnes = 0;
  let nbEcartes = 0;
  const rowBboxes: Array<[number, number, number, number] | null> = rows.map((r) => {
    try {
      return turf.bbox(turf.feature(r.geomGeoJson)) as [number, number, number, number];
    } catch {
      return null;
    }
  });
  const MARGIN_DEG = 1e-4; // ≈ 11 m — couvre largement le buffer de 1 m

  for (const g of residus) {
    let feat: GeoJSON.Feature<PolyGeom>;
    let buffered: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | undefined;
    let rbox: [number, number, number, number];
    try {
      feat = turf.feature(g);
      rbox = turf.bbox(feat) as [number, number, number, number];
      buffered = turf.buffer(feat, 1, { units: "meters" });
    } catch {
      nbEcartes++;
      continue;
    }
    if (!buffered) {
      nbEcartes++;
      continue;
    }

    let best = -1;
    let bestScore = 0;
    rows.forEach((row, i) => {
      const bb = rowBboxes[i];
      if (
        !bb ||
        rbox[0] > bb[2] + MARGIN_DEG || rbox[2] < bb[0] - MARGIN_DEG ||
        rbox[1] > bb[3] + MARGIN_DEG || rbox[3] < bb[1] - MARGIN_DEG
      ) return;
      try {
        const inter = turf.intersect(turf.featureCollection([buffered!, turf.feature(row.geomGeoJson)]));
        const a = inter ? turf.area(inter) : 0;
        if (a > bestScore) {
          bestScore = a;
          best = i;
        }
      } catch { /* candidate suivante */ }
    });

    if (best < 0) {
      nbEcartes++;
      continue;
    }
    const host = rows[best];
    try {
      const u = turf.union(turf.featureCollection([turf.feature(host.geomGeoJson), feat]));
      host.geomGeoJson = (u?.geometry as PolyGeom | undefined) ?? combineFragments([host.geomGeoJson, g]);
    } catch {
      host.geomGeoJson = combineFragments([host.geomGeoJson, g]);
    }
    host.surfaceM2 = areaM2(host.geomGeoJson);
    try {
      rowBboxes[best] = turf.bbox(turf.feature(host.geomGeoJson)) as [number, number, number, number];
    } catch { /* bbox précédente conservée */ }
    nbFusionnes++;
  }
  return { nbFusionnes, nbEcartes };
}

/**
 * Construit / rafraîchit la table `limite_section` pour un fichier source :
 * remplace le lot précédent, insère les sections dissoutes + rattachées à leur
 * commune, puis (re)détecte les chevauchements.
 */
export async function buildLimiteSections(
  result: DxfIngestionResult,
  sourceFichier: string,
): Promise<BuildSectionsResult> {
  const rawCandidates = result.sections;
  if (rawCandidates.length === 0) {
    await deleteSectionsBySource(sourceFichier);
    return { sourceFichier, nbSections: 0, nbSansCommune: 0, nbOverlaps: 0, nbEnveloppesEcartees: 0, nbResidusFusionnes: 0, nbResidusEcartes: 0 };
  }

  // Résidus non numérotés : un petit polygone SANS numéro est un artefact du
  // noding (trou ou lamelle découpé dans une vraie section), pas une section
  // dont le numéro manque. Mis de côté ici, puis FUSIONNÉ dans sa section hôte
  // après dissolution (`absorbResidus`). Les polygones numérotés ne passent
  // jamais par ce circuit.
  const allCandidates: typeof rawCandidates = [];
  const residus: PolyGeom[] = [];
  for (const c of rawCandidates) {
    if (c.numSection || areaM2(c.geomGeoJson4326) >= MIN_UNNUMBERED_AREA_M2) allCandidates.push(c);
    else residus.push(c.geomGeoJson4326);
  }
  if (allCandidates.length === 0) {
    await deleteSectionsBySource(sourceFichier);
    return { sourceFichier, nbSections: 0, nbSansCommune: 0, nbOverlaps: 0, nbEnveloppesEcartees: 0, nbResidusFusionnes: 0, nbResidusEcartes: residus.length };
  }

  // Enveloppes non numérotées : un polygone de section SANS numéro contenant le
  // point représentatif d'une section NUMÉROTÉE est un contour d'ensemble
  // (îlot/enveloppe dessiné en plus des vraies sections). Le garder créerait une
  // section « — » recouvrant plusieurs sections réelles (chevauchements massifs
  // au contrôle topologique) → écarté. Les sections sans numéro n'englobant
  // personne restent conservées (numéro simplement manquant).
  const numbered = allCandidates.filter((c) => c.numSection);
  const candidates = allCandidates.filter((c) => {
    if (c.numSection) return true;
    let bbox: [number, number, number, number];
    let feat: GeoJSON.Feature<PolyGeom>;
    try {
      feat = turf.feature(c.geomGeoJson4326);
      bbox = turf.bbox(feat) as [number, number, number, number];
    } catch {
      return true;
    }
    return !numbered.some((nb) => {
      const [lng, lat] = nb.repPoint4326;
      if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) return false;
      try {
        return turf.booleanPointInPolygon(turf.point(nb.repPoint4326), feat);
      } catch {
        return false;
      }
    });
  });
  const nbEnveloppesEcartees = allCandidates.length - candidates.length;
  if (candidates.length === 0) {
    await deleteSectionsBySource(sourceFichier);
    return { sourceFichier, nbSections: 0, nbSansCommune: 0, nbOverlaps: 0, nbEnveloppesEcartees, nbResidusFusionnes: 0, nbResidusEcartes: residus.length };
  }

  // Commune résolue PAR FRAGMENT, AVANT dissolution : un numéro de section n'est
  // unique que DANS sa commune (chaque commune a sa section 001, 002…). Dissoudre
  // par numéro seul fusionnait les sections homonymes de communes différentes —
  // et les sections « absorbées » disparaissaient de leur propre commune.
  const infos = await getCommuneInfo2026ForPoints(
    candidates.map((c) => ({ lng: c.repPoint4326[0], lat: c.repPoint4326[1] })),
  );

  type CommuneInfo = (typeof infos)[number];
  interface Group { numSection: string | null; info: CommuneInfo | null; geoms: PolyGeom[] }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  candidates.forEach((c, i) => {
    const info = infos[i] ?? null;
    // Sans numéro OU sans commune résolue : pas de clé de regroupement fiable →
    // le fragment reste une ligne à part (surtout ne pas fusionner au hasard).
    if (!c.numSection || !info?.syscol) {
      groups.push({ numSection: c.numSection ?? null, info, geoms: [c.geomGeoJson4326] });
      return;
    }
    const key = `${info.syscol}|${c.numSection}`;
    const g = byKey.get(key);
    if (g) {
      g.geoms.push(c.geomGeoJson4326);
    } else {
      const ng: Group = { numSection: c.numSection, info, geoms: [c.geomGeoJson4326] };
      byKey.set(key, ng);
      groups.push(ng);
    }
  });

  let nbSansCommune = 0;
  const rows: SectionInsert[] = groups.map((g) => {
    if (!g.info?.syscol) nbSansCommune++;
    const geom = dissolveGroup(g.geoms);
    return {
      region: g.info?.region ?? null,
      departement: g.info?.departement ?? null,
      commune: g.info?.nomCommune ?? null,
      syscolCommune: g.info?.syscol ?? null,
      numSection: g.numSection,
      surfaceM2: areaM2(geom),
      geomGeoJson: geom,
    };
  });

  // Absorption des résidus APRÈS dissolution : chaque section hôte est alors
  // complète, l'union comble ses trous/lamelles en une passe.
  const { nbFusionnes: nbResidusFusionnes, nbEcartes: nbResidusEcartes } = absorbResidus(rows, residus);

  await deleteSectionsBySource(sourceFichier);
  await insertLimiteSections(sourceFichier, rows);
  const nbOverlaps = await refreshOverlaps(sourceFichier);

  return { sourceFichier, nbSections: rows.length, nbSansCommune, nbOverlaps, nbEnveloppesEcartees, nbResidusFusionnes, nbResidusEcartes };
}
