"use client";
import { useMemo, useState } from "react";
import { Layers, X, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Classe DGID + libellé lisible (ordre = celui de CADASTRAL_CLASSES). */
const CLASS_OPTIONS: { value: string; label: string }[] = [
  { value: "limites_parcelles", label: "Limites de parcelle" },
  { value: "limites_sections", label: "Limites de section" },
  { value: "limites_tf", label: "Limites de titre foncier" },
  { value: "batiment", label: "Bâtiment" },
  { value: "piscine", label: "Piscine" },
  { value: "numero_parcelle", label: "N° de parcelle" },
  { value: "numero_section", label: "N° de section" },
  { value: "numero_tf", label: "N° de titre foncier" },
  { value: "numero_lot", label: "N° de lot" },
  { value: "numero_batiment", label: "N° de bâtiment" },
  { value: "nb_nv_bati", label: "Nb de niveaux (bâti)" },
  { value: "titre_parcelle", label: "Dénomination (titre)" },
  { value: "proprietaire", label: "Propriétaire" },
  { value: "ignore", label: "— Ignorer ce calque —" },
];

/**
 * Classes « cœur » du pipeline parcelles : quand l'inventaire ne reconnaît pas
 * un calque (`proposedClass` nul → « Ignorer » par défaut), on le pré-sélectionne
 * quand même si son nom normalisé porte un signal clair pour l'une d'elles.
 * Une proposition automatique existante (alias/flou) est toujours conservée
 * telle quelle : cette table ne fait que rattraper les calques laissés sur
 * « Ignorer ». `numero_tf` est volontairement strict (`…tf`) pour ne pas capter
 * « titre foncier », alias de `limites_tf`.
 */
const CORE_PRESELECT: { cls: string; re: RegExp }[] = [
  { cls: "numero_parcelle", re: /(numero|numeros|num|no|n)[ _-]*parcelle|parcel[ _-]*number/ },
  { cls: "numero_lot", re: /(numero|num|no|n)[ _-]*(de[ _-]*)?lot/ },
  { cls: "numero_tf", re: /(numero|num|no|n)[ _-]*tf/ },
  { cls: "limites_parcelles", re: /limites?[ _-]*parcelles?/ },
];

export interface LayerInventoryEntry {
  layer: string;
  rawLayer: string;
  count: number;
  geometryKinds: string[];
  proposedClass: string | null;
  method: "alias" | "fuzzy" | "none";
}

interface Props {
  fileName: string;
  layers: LayerInventoryEntry[];
  onCancel: () => void;
  /** Reçoit le mappage validé { calque_normalisé → classe | "ignore" }. */
  onConfirm: (mapping: Record<string, string>) => void;
  /**
   * Restreint les classes proposées dans le menu déroulant (ex. sections
   * seules : `["limites_sections", "numero_section"]`) — « Ignorer » reste
   * toujours disponible. Par défaut (omis) : toutes les classes DGID, comme
   * pour le pipeline parcelles.
   */
  allowedClasses?: string[];
}

/** Badge indiquant l'origine de la proposition automatique. */
function MethodBadge({ method }: { method: LayerInventoryEntry["method"] }) {
  if (method === "alias") {
    return <span className="text-[11px] text-emerald-400">✓ nom reconnu</span>;
  }
  if (method === "fuzzy") {
    return (
      <span className="text-[11px] text-amber-400 inline-flex items-center gap-1">
        <Sparkles className="w-3 h-3" /> rapprochement flou
      </span>
    );
  }
  return <span className="text-[11px] text-white/40">non reconnu</span>;
}

/**
 * Modale de mappage des calques (variante « simple ») : l'utilisateur confirme
 * ou corrige le rattachement de chaque calque à une classe du processus NICAD
 * avant de lancer le traitement. Chaque ligne est pré-remplie avec la classe
 * proposée automatiquement (ou « Ignorer » si le calque n'est pas reconnu).
 */
export default function LayerMappingModal({ fileName, layers, onCancel, onConfirm, allowedClasses }: Props) {
  const classOptions = useMemo(
    () =>
      allowedClasses
        ? CLASS_OPTIONS.filter((o) => o.value === "ignore" || allowedClasses.includes(o.value))
        : CLASS_OPTIONS,
    [allowedClasses],
  );

  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const l of layers) {
      let proposed = l.proposedClass ?? "ignore";
      // Rattrapage des calques cœur non reconnus : jamais laissés sur « Ignorer »
      // par défaut si leur nom porte un signal clair (cf. CORE_PRESELECT).
      if (proposed === "ignore") {
        const hit = CORE_PRESELECT.find((c) => c.re.test(l.layer));
        if (hit) proposed = hit.cls;
      }
      // Une proposition automatique hors du périmètre restreint (ex. calque
      // reconnu comme "limites_parcelles" alors que seules les classes
      // section sont proposées ici) doit retomber sur "Ignorer" — sinon elle
      // resterait en mémoire (état initial) sans jamais apparaître dans le
      // menu déroulant filtré, et serait soumise telle quelle au clic.
      init[l.layer] = !allowedClasses || allowedClasses.includes(proposed) ? proposed : "ignore";
    }
    return init;
  });

  const keptCount = useMemo(
    () => Object.values(mapping).filter((v) => v !== "ignore").length,
    [mapping],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-white/10 bg-[oklch(0.20_0.02_240)] shadow-2xl">
        {/* En-tête */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <Layers className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Mappage des calques</h2>
              <p className="text-sm text-white/50">
                {fileName} · {layers.length} calque(s) détecté(s)
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="p-1 rounded-md hover:bg-white/10 text-white/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="px-5 pt-4 text-sm text-white/60">
          Vérifiez le rattachement de chaque calque à une classe du processus NICAD.
          Les propositions automatiques sont pré-remplies ; corrigez-les si nécessaire.
          Les calques laissés sur « Ignorer » ne seront pas exploités.
        </p>

        {/* Tableau */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {layers.map((l) => (
            <div
              key={l.layer}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-white" title={l.rawLayer}>
                  {l.rawLayer}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-white/40">
                  <span>{l.count} entité(s)</span>
                  <span>·</span>
                  <span>{l.geometryKinds.join(", ") || "—"}</span>
                  <span>·</span>
                  <MethodBadge method={l.method} />
                </div>
              </div>
              <ArrowRight className="w-4 h-4 shrink-0 text-white/30" />
              <select
                value={mapping[l.layer]}
                onChange={(e) => setMapping((m) => ({ ...m, [l.layer]: e.target.value }))}
                className="shrink-0 w-52 rounded-md border border-white/10 bg-[oklch(0.16_0.02_240)] px-2 py-1.5 text-sm text-white outline-none focus:border-cyan-400/60"
              >
                {classOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Pied */}
        <div className="flex items-center justify-between gap-4 p-5 border-t border-white/10">
          <span className="text-sm text-white/50">{keptCount} calque(s) conservé(s)</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Annuler
            </Button>
            <Button onClick={() => onConfirm(mapping)}>Lancer le traitement</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
