/**
 * Diagnostic NICAD par section numérotée : rejoue exactement le rattachement
 * `Analysis.fileName === LimiteSection.sourceFichier` + point-dans-polygone
 * utilisé par `fillMissingNicadForAnalysis`/`fillMissingNicadForSection`
 * (src/lib/cadastre/nicad-fill-missing.ts), mais journalise le détail par
 * section au lieu de se limiter à l'agrégat retourné à l'UI.
 *
 * Usage : npx tsx scripts/diag-nicad-check.ts [numSection]
 *   - sans argument : vue d'ensemble (top sections avec NICAD, sections sans
 *     aucune parcelle rattachée, sections 100% sans NICAD)
 *   - avec un numéro : détail complet de cette section (rattachement,
 *     features vues/hors-polygone, classification NICAD de chacune)
 */
import * as turf from "@turf/turf";
import { prisma } from "../src/lib/prisma";
import { loadGeoJsonFromKey } from "../src/lib/geo-storage";
import { extractNicad } from "../src/lib/geo-engine";
import { NICAD_TOTAL_LENGTH } from "../src/lib/nicad";

const MISSING_NICAD_VALUES = new Set([
  "", "null", "undefined", "na", "n/a", "néant", "neant", "aucun", "sans nicad", "0", "-",
]);
const isMissingNicad = (nicad: string): boolean => MISSING_NICAD_VALUES.has(nicad.trim().toLowerCase());
const isPolygonal = (f: any): boolean => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

function representativePoint(feature: any): [number, number] | null {
  try {
    return turf.pointOnFeature(feature).geometry.coordinates as [number, number];
  } catch {
    try {
      return turf.centroid(feature).geometry.coordinates as [number, number];
    } catch {
      return null;
    }
  }
}

type GeoFC = { type: "FeatureCollection"; features: any[] };
const geoCache = new Map<number, GeoFC | null>();

async function loadAnalysisGeoJson(analysis: { id: number; correctedData: string | null; geojsonKey: string | null; geoJsonData: string | null }): Promise<GeoFC | null> {
  if (geoCache.has(analysis.id)) return geoCache.get(analysis.id)!;
  const raw = analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  let parsed: GeoFC | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  geoCache.set(analysis.id, parsed);
  return parsed;
}

interface SectionReport {
  numSection: string;
  sourceFichier: string;
  analysisIds: number[];
  insideCount: number;
  missingCount: number;
  referenceCount: number; // NICAD complet (16), sert de référence
  otherLengthCount: number; // NICAD présent mais ni "missing" ni longueur totale (invisible à l'algo)
  nonPolygonalOrUntestable: number;
}

async function analyzeSection(numSection: string, geomGeoJson: any, sourceFichier: string): Promise<SectionReport> {
  const report: SectionReport = {
    numSection,
    sourceFichier,
    analysisIds: [],
    insideCount: 0,
    missingCount: 0,
    referenceCount: 0,
    otherLengthCount: 0,
    nonPolygonalOrUntestable: 0,
  };
  const analyses = await prisma.analysis.findMany({
    where: { fileName: sourceFichier },
    select: { id: true, correctedData: true, geojsonKey: true, geoJsonData: true },
  });
  if (analyses.length === 0) return report;

  const sectionPoly = turf.feature(geomGeoJson);

  for (const analysis of analyses) {
    const geoJson = await loadAnalysisGeoJson(analysis);
    if (!geoJson) continue;
    const features = geoJson.features ?? [];
    let touchedThisAnalysis = false;

    for (const feature of features) {
      if (!isPolygonal(feature)) continue;
      const point = representativePoint(feature);
      if (!point) continue;
      let inside = false;
      try {
        inside = turf.booleanPointInPolygon(turf.point(point), sectionPoly as any);
      } catch {
        continue;
      }
      if (!inside) continue;

      touchedThisAnalysis = true;
      report.insideCount++;
      const nicad = extractNicad(feature.properties);
      if (isMissingNicad(nicad)) {
        report.missingCount++;
      } else if (nicad.length === NICAD_TOTAL_LENGTH) {
        report.referenceCount++;
      } else {
        report.otherLengthCount++;
      }
    }
    if (touchedThisAnalysis) report.analysisIds.push(analysis.id);
  }
  return report;
}

async function main() {
  const target = process.argv[2];

  const sections = target
    ? await prisma.$queryRaw<Array<{ numSection: string; sourceFichier: string; geomGeoJson: any }>>`
        SELECT "numSection", "sourceFichier", "geomGeoJson"
        FROM "limite_section"
        WHERE "numSection" = ${target}
      `
    : await prisma.$queryRaw<Array<{ numSection: string; sourceFichier: string; geomGeoJson: any }>>`
        SELECT "numSection", "sourceFichier", "geomGeoJson"
        FROM "limite_section"
        WHERE "numSection" IS NOT NULL AND "numSection" <> ''
      `;

  if (target) {
    const matches = sections.filter((s) => s.numSection === target);
    if (matches.length === 0) {
      console.log(`Aucune section numérotée "${target}" trouvée dans limite_section.`);
      return;
    }
    for (const s of matches) {
      const r = await analyzeSection(s.numSection, s.geomGeoJson, s.sourceFichier);
      console.log(`\n=== Section ${r.numSection} (sourceFichier="${r.sourceFichier}") ===`);
      console.log(`  Analyses avec ce fileName : ${r.analysisIds.length > 0 ? r.analysisIds.join(", ") : "AUCUNE (mismatch Analysis.fileName / LimiteSection.sourceFichier)"}`);
      console.log(`  Parcelles rattachées (point-dans-polygone) : ${r.insideCount}`);
      console.log(`    - NICAD manquant (missingCount)          : ${r.missingCount}`);
      console.log(`    - NICAD complet 16 (référence potentielle): ${r.referenceCount}`);
      console.log(`    - NICAD "autre longueur" (invisible!)     : ${r.otherLengthCount}`);
      if (r.insideCount === 0) {
        console.log(`  → Aucune parcelle n'est tombée dans le polygone de section : vérifier la géométrie de section ou le fichier source.`);
      } else if (r.missingCount === 0 && r.otherLengthCount > 0) {
        console.log(`  → Suspect : ${r.otherLengthCount} parcelle(s) ont un NICAD non standard (ni vide, ni 16 chars) donc ni comptées "manquantes" ni "référence".`);
      } else if (r.missingCount > 0 && r.referenceCount === 0) {
        console.log(`  → ${r.missingCount} parcelle(s) sans NICAD mais AUCUNE référence (aucun NICAD complet dans la section) : unresolvedCount, pas d'attribution possible.`);
      }
    }
    return;
  }

  // Vue d'ensemble
  console.log(`Sections numérotées : ${sections.length}`);
  const bySource = new Map<string, typeof sections>();
  for (const s of sections) {
    if (!bySource.has(s.sourceFichier)) bySource.set(s.sourceFichier, []);
    bySource.get(s.sourceFichier)!.push(s);
  }
  console.log(`Fichiers sources distincts : ${bySource.size}`);
  const analysisFileNames = new Set((await prisma.analysis.findMany({ select: { fileName: true } })).map((a) => a.fileName));
  let orphanSources = 0;
  for (const src of bySource.keys()) {
    if (!analysisFileNames.has(src)) orphanSources++;
  }
  console.log(`Fichiers sources sans Analysis correspondante (mismatch) : ${orphanSources} / ${bySource.size}`);

  // Échantillonne quelques sections par source pour donner un aperçu rapide
  const sampleSources = [...bySource.keys()].slice(0, 3);
  for (const src of sampleSources) {
    const secs = bySource.get(src)!.slice(0, 3);
    console.log(`\n--- Échantillon source "${src}" ---`);
    for (const s of secs) {
      const r = await analyzeSection(s.numSection, s.geomGeoJson, s.sourceFichier);
      console.log(
        `  section ${r.numSection} : ${r.insideCount} parcelle(s) rattachée(s), ${r.missingCount} sans NICAD, ${r.referenceCount} référence, ${r.otherLengthCount} autre longueur`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error("ERR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
