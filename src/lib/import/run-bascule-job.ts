/**
 * run-bascule-job.ts — exécution asynchrone du job d'identification en masse
 * pour "Migration en masse" (`job.kind === "bascule-nicad"`, dispatché depuis
 * run-shapefile-job.ts). Lit un shapefile portant une colonne NICAD (2013),
 * et pour chaque NICAD valide, retrouve sa cible 2026 (commune + section, cas
 * simple ET complexe) via la même logique que la page "Basculement" —
 * `identifierBasculementNicad` (lib/cadastre/basculement.ts).
 *
 * AUCUNE écriture en base ici : ce job produit uniquement un rapport de
 * prévisualisation (`job.report`). Le basculement réel est un acte séparé,
 * déclenché par l'utilisateur après revue — `executerBasculementListe`
 * (`_actions/migration.ts`).
 */
import * as shapefile from "shapefile";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { identifierBasculementNicad, type IdentificationResult } from "@/lib/cadastre/basculement";
import { validateNicadFormat } from "@/lib/cadastre/nicad-logic";
import type { FieldMapping } from "./field-mapping";
import { loadShapefilePair } from "./run-shapefile-job";
import { getImportJob, setJobPhase, assertNotCancelled, markJobFailed, JobCancelledError } from "./jobs";

export interface BasculeNicadItem {
  nicadAncien: string;
  dejaAJour: boolean;
  clean: boolean;
  flags: string[];
  proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
  commune2013?: string;
  commune2026?: string;
  // Confirmation explicite (issue de `identifierBasculementNicad`) que la
  // section cible existe bien en 2026 — `null`/`false` signifie qu'un
  // basculement "simple" (sans `proposition.sectionNouvelle`) ne peut PAS
  // être garanti sûr : `basculerNicadCore` ne vérifie l'existence de la
  // section QUE dans son branchement "complexe" (cf. finding 1 revue finale).
  sectionExisteEn2026: boolean | null;
}

/** Ligne de shapefile écartée avant identification (valeur NICAD absente ou mal formée). */
export interface BasculeNicadInvalide {
  raw: string;
  motif: string;
}

export interface BasculeNicadReport {
  kind: "bascule-nicad";
  items: BasculeNicadItem[];
  invalides: BasculeNicadInvalide[];
  stats: { total: number; invalides: number; dejaAJour: number; clean: number; avecDrapeaux: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(props: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export async function runBasculeNicadJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run-bascule] job ${jobId} introuvable`);
    return;
  }

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const { shpBuf, dbfBuf } = await loadShapefilePair(job.fileKey);
    const fieldMapping = (job.layerMapping as FieldMapping | null) ?? undefined;

    const source = await shapefile.read(shpBuf, dbfBuf);
    const features = (source.features ?? []) as GeoJSON.Feature[];

    // Extraction + dédoublonnage + validation de format AVANT toute
    // identification — un shapefile réel peut répéter le même NICAD sur
    // plusieurs features (multi-parties), et contenir des colonnes vides
    // ou mal formées (saisie manuelle en amont).
    const seen = new Set<string>();
    const nicadsValides: string[] = [];
    const invalides: BasculeNicadInvalide[] = [];
    for (const f of features) {
      const props = f.properties ?? {};
      const raw = fieldMapping?.nicad
        ? pick(props, fieldMapping.nicad)
        : pick(props, "nicad", "nic", "num_nicad", "code_nicad", "codif");
      if (!raw) {
        invalides.push({ raw: "", motif: "Valeur NICAD absente" });
        continue;
      }
      const digits = raw.replace(/\D/g, "");
      if (digits.length !== 16 || !validateNicadFormat(digits).valid) {
        invalides.push({
          raw,
          motif:
            digits.length !== 16
              ? `Longueur invalide (${digits.length} chiffre(s) au lieu de 16)`
              : "Format NICAD invalide (Syscol/section/parcelle incohérents)",
        });
        continue;
      }
      if (seen.has(digits)) continue;
      seen.add(digits);
      nicadsValides.push(digits);
    }

    await assertNotCancelled(jobId);
    await setJobPhase(jobId, "identify", 10);

    const items: BasculeNicadItem[] = [];
    let nbDejaAJour = 0;
    let nbClean = 0;
    let nbAvecDrapeaux = 0;

    // Mémoïsation par (syscol+section) — les 11 premiers chiffres du NICAD
    // (positions 1–8 Syscol, 9–11 Section ; cf. nicad-logic.ts) déterminent
    // À EUX SEULS tout ce qu'`identifierBasculementNicad` interroge en base
    // (commune 2013/2026, correspondance, recouvrement spatial de section) —
    // le numéro de parcelle (5 derniers chiffres) n'entre dans AUCUNE requête.
    // Un shapefile réel porte typiquement une seule commune (souvent une
    // poignée de sections) sur des dizaines de milliers de parcelles : sans
    // ce cache, `identifierBasculementNicad` recalcule les mêmes requêtes
    // spatiales/DB pour chaque parcelle (finding 5 revue finale). On ne
    // met en cache QUE le résultat sans le champ `nicad` (spécifique à
    // chaque parcelle), reconstruit ci-dessous à partir du NICAD courant.
    const identificationCache = new Map<string, Omit<IdentificationResult, "nicad">>();

    for (let i = 0; i < nicadsValides.length; i++) {
      const nicadAncien = nicadsValides[i];
      const cacheKey = nicadAncien.slice(0, 11);
      const cached = identificationCache.get(cacheKey);
      let res: IdentificationResult;
      if (cached) {
        res = cached.success
          ? {
              ...cached,
              nicad: {
                syscol: nicadAncien.slice(0, 8),
                section: nicadAncien.slice(8, 11),
                numParcelle: nicadAncien.slice(11, 16),
                full: nicadAncien,
              },
            }
          : { ...cached };
      } else {
        res = await identifierBasculementNicad(nicadAncien);
        const { nicad, ...rest } = res;
        void nicad; // exclu volontairement du cache (spécifique à chaque parcelle)
        identificationCache.set(cacheKey, rest);
      }

      if (!res.success) {
        items.push({
          nicadAncien,
          dejaAJour: false,
          clean: false,
          flags: [res.error ?? "Identification échouée."],
          proposition: null,
          sectionExisteEn2026: null,
        });
        nbAvecDrapeaux++;
      } else if (res.dejaAJour) {
        items.push({
          nicadAncien,
          dejaAJour: true,
          clean: false,
          flags: res.flags,
          proposition: null,
          commune2026: res.commune2026?.nomCommune,
          sectionExisteEn2026: null,
        });
        nbDejaAJour++;
      } else {
        const clean = !!res.clean;
        items.push({
          nicadAncien,
          dejaAJour: false,
          clean,
          flags: res.flags,
          proposition: res.proposition ?? null,
          commune2013: res.commune2013?.nomCommune ?? undefined,
          commune2026: res.commune2026?.nomCommune ?? undefined,
          sectionExisteEn2026: res.sectionExisteEn2026 ?? null,
        });
        if (clean) nbClean++;
        else nbAvecDrapeaux++;
      }

      // Points de contrôle toutes les 20 identifications : suffisamment
      // fréquent pour que la barre de progression bouge visiblement (cf.
      // leçon du §58 CONCEPTS-TRAITEMENT-DXF.md — un job qui reste figé sur
      // la même valeur est indiscernable d'un blocage), sans réécrire la
      // ligne en base à chaque itération individuelle.
      if (i % 20 === 0 || i === nicadsValides.length - 1) {
        await assertNotCancelled(jobId);
        const pct = 10 + Math.round(((i + 1) / Math.max(nicadsValides.length, 1)) * 85);
        await setJobPhase(jobId, "identify", Math.min(pct, 95));
      }
    }

    await prisma.importJob.updateMany({
      where: { id: jobId, status: { not: "cancelled" } },
      data: {
        status: "completed",
        phase: "done",
        progress: 100,
        totalBuilt: items.length,
        report: {
          kind: "bascule-nicad",
          items,
          invalides,
          stats: {
            total: features.length,
            invalides: invalides.length,
            dejaAJour: nbDejaAJour,
            clean: nbClean,
            avecDrapeaux: nbAvecDrapeaux,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run-bascule] ${err.message}`);
      return;
    }
    console.error(`[import/run-bascule] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}
