/**
 * assign-nicad-2026.ts
 *
 * Étape DB du pipeline DXF : assemble le NICAD 16 caractères de chaque parcelle
 * extraite (cf. `parcelle-ingestion.ts`) en résolvant le Syscol par JOINTURE
 * SPATIALE sur le référentiel des communes 2026 (`cad_communes_2026`).
 *
 *   NICAD = [Syscol×8 issu de cad_communes_2026] + [Section×3 DXF] + [Parcelle×5 DXF]
 *
 * Le DXF ne porte pas le préfixe territorial : seule la commune 2026 contenant
 * la parcelle fournit le Syscol officiel. Cette étape est isolée de l'ingestion
 * géométrique (pure, testable sans DB) car elle dépend de Prisma/PostGIS.
 */
import { getSyscols2026ForPoints } from "./data";
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

  const matches = await getSyscols2026ForPoints(
    parcelles.map((p) => ({ lng: p.repPoint4326[0], lat: p.repPoint4326[1] })),
  );

  let nbSansCommune2026 = 0;
  let nbCommune2026Approx = 0;

  parcelles.forEach((p, i) => {
    const m = matches[i];
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
