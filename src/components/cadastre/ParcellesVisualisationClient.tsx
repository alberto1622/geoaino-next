"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Eye, EyeOff, MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorTypeColor } from "@/lib/utils";
import type { ErrorRow } from "@/components/cadastre/ParcellesMapLibre";

// `react-map-gl`/`maplibre-gl` touchent `window` au chargement → composant
// client-only (mêmes raisons que `MapLibreMap` dans `MapAnalysisClient.tsx`).
const ParcellesMapLibre = dynamic(() => import("@/components/cadastre/ParcellesMapLibre"), {
  ssr: false,
});

export interface FileItem {
  id: number;
  fileName: string;
  fileFormat: string | null;
  totalFeatures: number | null;
  errorCount: number | null;
  commune: string | null;
  region: string | null;
  createdAt: string;
}

type Bbox = [number, number, number, number];

interface Meta {
  bbox: Bbox | null;
  errors: ErrorRow[];
}

// Libellés FR complets (les 11 types de `errorTypeColor`, lib/utils.ts) —
// ERROR_TYPE_LABELS de MapLibreMap.tsx en omet volontairement deux (couches
// toujours affichées là-bas, non pertinent ici où tout passe par la légende).
const ERROR_TYPE_LABELS: Record<string, string> = {
  overlap: "Chevauchement",
  gap: "Trou",
  sliver: "Esquille",
  duplicate: "Doublon NICAD",
  invalid_geom: "Géométrie invalide",
  boundary_cross: "Sort des limites administratives",
  missing_nicad: "NICAD manquant",
  short_nicad: "NICAD trop court",
  self_intersect: "Auto-intersection",
  section_mismatch: "Incohérence de section",
  multi_numero: "Plusieurs numéros",
};

const DEFAULT_SELECTED_COUNT = 3;

export default function ParcellesVisualisationClient({ files }: { files: FileItem[] }) {
  const [selectedIds, setSelectedIds] = useState<number[]>(() =>
    files.slice(0, DEFAULT_SELECTED_COUNT).map((f) => f.id),
  );
  const [metaById, setMetaById] = useState<Map<number, Meta>>(new Map());
  const [loading, setLoading] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  // ── Chargement des fichiers sélectionnés (uniquement ceux pas déjà en cache) ──
  // Rendu par tuiles vectorielles (cf. ParcellesMapLibre) : on ne récupère ICI
  // que les erreurs (petit volume) et l'emprise (`map-meta`, sans géométrie) —
  // jamais le GeoJSON complet d'un fichier, qui peut peser 50-80 Mo sur les
  // gros DXF cadastraux et rendait la page inutilisable.
  useEffect(() => {
    const missing = selectedIds.filter((id) => !metaById.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const results = await Promise.all(
          missing.map(async (id) => {
            const [metaRes, errRes] = await Promise.all([
              fetch(`/api/analyses/${id}/map-meta`),
              fetch(`/api/analyses/${id}/errors?ro=1`),
            ]);
            const meta = metaRes.ok ? await metaRes.json() : { bbox: null };
            const errors = errRes.ok ? await errRes.json() : [];
            return [id, { bbox: meta.bbox ?? null, errors }] as const;
          }),
        );
        if (cancelled) return;
        setMetaById((prev) => {
          const next = new Map(prev);
          for (const [id, data] of results) next.set(id, data as Meta);
          return next;
        });
      } catch (err) {
        if (!cancelled) toast.error(`Chargement échoué : ${String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const toggleFile = useCallback((id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const toggleErrorType = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const errorsById = useMemo(() => {
    const map = new Map<number, ErrorRow[]>();
    for (const id of selectedIds) map.set(id, metaById.get(id)?.errors ?? []);
    return map;
  }, [selectedIds, metaById]);

  // ── Emprise combinée (union des bbox `map-meta`) pour le fit initial ──────
  const fitBounds = useMemo<Bbox | null>(() => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    let found = false;
    for (const id of selectedIds) {
      const b = metaById.get(id)?.bbox;
      if (!b) continue;
      found = true;
      w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]);
    }
    return found ? [w, s, e, n] : null;
  }, [selectedIds, metaById]);

  // ── Légende : types d'erreur présents dans la sélection courante, avec compteur ──
  const errorTypeCounts = new Map<string, number>();
  for (const id of selectedIds) {
    for (const err of metaById.get(id)?.errors ?? []) {
      if (err.corrected) continue;
      const key = err.errorType.toLowerCase();
      errorTypeCounts.set(key, (errorTypeCounts.get(key) ?? 0) + 1);
    }
  }
  const legendEntries = Array.from(errorTypeCounts.entries()).sort((a, b) => b[1] - a[1]);

  const handleExport = useCallback(async () => {
    if (selectedIds.length === 0) {
      toast.error("Sélectionnez au moins un fichier.");
      return;
    }
    setExporting(true);
    try {
      const res = await fetch("/api/cadastre/export/shapefile/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisIds: selectedIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Échec de l'export.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `parcelles_${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export shapefile téléchargé.");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setExporting(false);
    }
  }, [selectedIds]);

  return (
    <div className="relative h-[calc(100vh-180px)] min-h-[500px] overflow-hidden rounded-xl border border-border/60">
      <ParcellesMapLibre selectedIds={selectedIds} errorsById={errorsById} hiddenTypes={hiddenTypes} fitBounds={fitBounds} />

      {loading && (
        <div className="absolute left-3 top-3 z-1000 flex items-center gap-2 rounded-lg bg-background/95 px-3 py-1.5 text-xs shadow backdrop-blur">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement des fichiers…
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="absolute right-3 top-3 z-1000 gap-2 bg-background/95 shadow backdrop-blur"
        onClick={handleExport}
        disabled={exporting || selectedIds.length === 0}
      >
        {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Exporter en SHP
      </Button>

      {!panelOpen && (
        <Button
          size="sm"
          variant="outline"
          className="absolute right-3 bottom-3 z-1000 gap-1.5 bg-background/95 shadow backdrop-blur"
          onClick={() => setPanelOpen(true)}
        >
          <MapPinned className="h-4 w-4" /> Fichiers ({selectedIds.length})
        </Button>
      )}

      {panelOpen && (
        <div className="absolute bottom-3 right-3 top-14 z-1000 flex w-80 max-w-[85vw] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <h3 className="text-sm font-semibold">
              Fichiers chargés
              <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {selectedIds.length} sélectionné{selectedIds.length > 1 ? "s" : ""}
              </span>
            </h3>
            <button
              onClick={() => setPanelOpen(false)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="Replier le panneau"
            >
              <EyeOff className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            <div className="space-y-1.5">
              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun fichier traité pour l&apos;instant.</p>
              ) : (
                files.map((f) => {
                  const checked = selectedIds.includes(f.id);
                  return (
                    <label
                      key={f.id}
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs transition-colors ${
                        checked ? "border-primary/40 bg-primary/5" : "border-border hover:bg-secondary/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFile(f.id)}
                        className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{f.fileName}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                          <span>{f.totalFeatures ?? 0} parcelle{(f.totalFeatures ?? 0) > 1 ? "s" : ""}</span>
                          {(f.errorCount ?? 0) > 0 && (
                            <span className="text-amber-500">{f.errorCount} erreur{f.errorCount! > 1 ? "s" : ""}</span>
                          )}
                          {f.commune && <span>{f.commune}</span>}
                          <span>{new Date(f.createdAt).toLocaleDateString("fr-FR")}</span>
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            {legendEntries.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
                  Légende des erreurs
                </h4>
                <div className="space-y-1">
                  {legendEntries.map(([type, count]) => {
                    const hidden = hiddenTypes.has(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => toggleErrorType(type)}
                        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                          hidden ? "border-border opacity-40" : "border-border hover:bg-secondary/40"
                        }`}
                        title={hidden ? "Cliquer pour afficher" : "Cliquer pour masquer"}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: errorTypeColor(type) }} />
                        <span className="flex-1 truncate">{ERROR_TYPE_LABELS[type] ?? type}</span>
                        <span className="font-mono text-muted-foreground">{count}</span>
                        {hidden ? <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" /> : <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Page de consultation — aucune correction possible ici. Pour corriger, ouvrez le fichier
                  depuis <span className="font-medium">Historique</span>.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
