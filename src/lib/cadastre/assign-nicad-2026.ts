/**
 * assign-nicad-2026.ts
 *
 * Étape DB du pipeline DXF : assemble le NICAD 16 caractères de chaque parcelle
 * extraite (cf. `parcelle-ingestion.ts`) en résolvant Syscol + section par
 * JOINTURE SPATIALE, avec DEUX sources par ordre de priorité :
 *
 *   1. `limite_section` (table QA construite via /cadastre/sections) —
 *      prioritaire quand elle couvre le point : Syscol ET section viennent de
 *      la MÊME ligne, cohérents par construction, et bénéficient de toutes
 *      les corrections apportées depuis cette page (chevauchements résolus,
 *      fusions, numéros complétés) — contrairement à la couche `limites_sections`
 *      embarquée dans CE DXF (souvent absente, ou sujette aux mêmes anneaux
 *      invalides/débordements que documentés dans
 *      docs/CONCEPTS-TRAITEMENT-DXF.md), qui ne fait donc plus foi que par défaut.
 *   2. `cad_communes_2026` (repli) : ne fournit QUE le Syscol (communes,
 *      pas de découpage par section) — utilisé pour le Syscol quand aucune
 *      `limite_section` ne couvre le point, la section restant alors celle déjà
 *      résolue en ingestion (jointure sur la couche DXF `limites_sections`).
 *
 *   NICAD = [Syscol×8] + [Section×3] + [Parcelle×5 DXF]
 *
 * Le DXF ne porte pas le préfixe territorial : il faut toujours une jointure
 * spatiale externe pour le Syscol. Cette étape est isolée de l'ingestion
 * géométrique (pure, testable sans DB) car elle dépend de Prisma/PostGIS.
 */
import { getSyscols2026ForPoints } from "./data";
import { getSectionsForPoints } from "./sections-data";
import { buildNicad } from "@/lib/nicad";
import type { DxfIngestionResult } from "@/lib/parcelle-ingestion";

/**
 * Mute en place les parcelles d'un résultat d'ingestion DXF : résout le Syscol
 * 2026 de chaque parcelle (jointure spatiale), construit le NICAD et met à jour
 * les compteurs/avertissements du rapport. Retourne le même objet pour permettre
 * le chaînage.
 */
export async function assignNicad2026FromCommunes(
  result: DxfIngestionResult,
): Promise<DxfIngestionResult> {
  const { parcelles, report } = result;
  if (parcelles.length === 0) return result;

  const points = parcelles.map((p) => ({ lng: p.repPoint4326[0], lat: p.repPoint4326[1] }));
  const [communeMatches, sectionMatches] = await Promise.all([
    getSyscols2026ForPoints(points),
    getSectionsForPoints(points),
  ]);

  let nbSansCommune2026 = 0;
  let nbCommune2026Approx = 0;
  let nbSectionDepuisTableSections = 0;
  let nbSectionApprox = 0;

  parcelles.forEach((p, i) => {
    const sm = sectionMatches[i];
    if (sm?.syscolCommune && sm.numSection) {
      // `limite_section` couvre le point : Syscol ET section en font autorité
      // ensemble, prioritaire sur la couche DXF `limites_sections` (souvent
      // absente ou moins fiable que la table QA de /cadastre/sections).
      if (p.numeroSection === null && report.nbSansSection > 0) report.nbSansSection--;
      p.syscolCommune2026 = sm.syscolCommune;
      p.nomCommune2026 = sm.commune ?? communeMatches[i]?.nomCommune ?? null;
      p.numeroSection = sm.numSection;
      p.nicad = buildNicad(sm.syscolCommune, p.numeroSection, p.numeroParcelle5);
      nbSectionDepuisTableSections++;
      if (sm.approx) nbSectionApprox++;
      return;
    }

    const m = communeMatches[i];
    if (m?.syscol) {
      p.syscolCommune2026 = m.syscol;
      p.nomCommune2026 = m.nomCommune;
      p.nicad = buildNicad(m.syscol, p.numeroSection, p.numeroParcelle5);
      if (m.approx) nbCommune2026Approx++;
    } else {
      p.syscolCommune2026 = null;
      p.nomCommune2026 = null;
      p.nicad = null;
      nbSansCommune2026++;
    }
  });

  report.nbSansCommune2026 = nbSansCommune2026;
  report.nbCommune2026Approx = nbCommune2026Approx;
  report.nbSectionDepuisTableSections = nbSectionDepuisTableSections;
  report.nbSectionApprox = nbSectionApprox;

  if (nbSectionDepuisTableSections > 0) {
    report.warnings.push(
      `${nbSectionDepuisTableSections} parcelle(s) rattachée(s) à une section via la table ` +
        "/cadastre/sections (Syscol + section résolus ensemble).",
    );
  }
  if (nbSectionApprox > 0) {
    report.warnings.push(
      `${nbSectionApprox} parcelle(s) rattachée(s) à une section /cadastre/sections par proximité ` +
        "(point hors contenance stricte, ≤ 50 m d'une limite) — section à vérifier.",
    );
  }
  if (nbCommune2026Approx > 0) {
    report.warnings.push(
      `${nbCommune2026Approx} parcelle(s) rattachée(s) à une commune 2026 par proximité ` +
        "(point hors contenance stricte, ≤ 50 m d'une limite) — Syscol à vérifier.",
    );
  }
  if (nbSansCommune2026 > 0) {
    report.warnings.push(
      `${nbSansCommune2026} parcelle(s) sans commune 2026 correspondante dans cad_communes_2026 ` +
        "(hors emprise du référentiel) — NICAD non construit.",
    );
  }

  return result;
}
