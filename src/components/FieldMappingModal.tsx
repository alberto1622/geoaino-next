"use client";
import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TargetFieldDef } from "@/lib/import/field-mapping";

interface AvailableField {
  name: string;
  sampleValues: string[];
}

interface Props {
  fileName: string;
  targetFields: TargetFieldDef[];
  availableFields: AvailableField[];
  proposedMapping: Record<string, string>;
  onCancel: () => void;
  /** Reçoit le mappage validé { champ_cible → colonne .dbf source }. */
  onConfirm: (mapping: Record<string, string>) => void;
}

/**
 * Modale de mappage des champs attribut d'un shapefile : l'utilisateur associe
 * chaque champ cible (fixe, défini par le type d'import) à une colonne .dbf
 * détectée. Sens inverse de `LayerMappingModal` (calque source → classe DGID) :
 * ici c'est le champ CIBLE qui est fixe et la colonne SOURCE qui varie.
 */
export default function FieldMappingModal({
  fileName,
  targetFields,
  availableFields,
  proposedMapping,
  onCancel,
  onConfirm,
}: Props) {
  const [mapping, setMapping] = useState<Record<string, string>>(() => ({ ...proposedMapping }));

  const missingRequired = useMemo(
    () => targetFields.filter((f) => f.required && !mapping[f.key]),
    [targetFields, mapping],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-white/10 bg-[oklch(0.20_0.02_240)] shadow-2xl">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <ListChecks className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Mappage des champs</h2>
              <p className="text-sm text-white/50">
                {fileName} · {availableFields.length} colonne(s) détectée(s)
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="p-1 rounded-md hover:bg-white/10 text-white/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="px-5 pt-4 text-sm text-white/60">
          Associez chaque champ attendu à une colonne du fichier .dbf. Les propositions
          automatiques sont pré-remplies ; corrigez-les si nécessaire.
        </p>

        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {targetFields.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-white">
                  {f.label}
                  {f.required ? " *" : ""}
                </div>
              </div>
              <select
                value={mapping[f.key] ?? ""}
                onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                className="shrink-0 w-64 rounded-md border border-white/10 bg-[oklch(0.16_0.02_240)] px-2 py-1.5 text-sm text-white outline-none focus:border-cyan-400/60"
              >
                <option value="">— Non mappé —</option>
                {availableFields.map((col) => (
                  <option key={col.name} value={col.name}>
                    {col.name}
                    {col.sampleValues[0] ? ` (ex: ${col.sampleValues[0]})` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 p-5 border-t border-white/10">
          <span className="text-sm text-white/50">
            {missingRequired.length > 0
              ? `Champ requis manquant : ${missingRequired.map((f) => f.label).join(", ")}`
              : "Tous les champs requis sont mappés"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Annuler
            </Button>
            <Button onClick={() => onConfirm(mapping)} disabled={missingRequired.length > 0}>
              Lancer le traitement
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
