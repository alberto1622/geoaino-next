"use client";
import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Search, Download, MapPin, AlertTriangle,
  ChevronLeft, ChevronRight, X, SlidersHorizontal,
  FileText, CheckCircle, Trash2, Minus, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { NavBar } from "@/components/NavBar";
import { toNum } from "@/lib/utils";

const PAGE_SIZE = 100;

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "text-red-400",
  HIGH: "text-orange-400",
  MEDIUM: "text-yellow-400",
  LOW: "text-blue-400",
};

type GeoFeature = { type?: string; geometry?: unknown; properties: Record<string, unknown> };
type Feature = GeoFeature & { _rowId: number };

function parseFeatures(geoJsonData: string | null): Feature[] {
  if (!geoJsonData) return [];
  try {
    const fc = JSON.parse(geoJsonData) as { features?: GeoFeature[] };
    return (fc.features ?? []).map((f, i) => ({ ...f, _rowId: i }));
  } catch { return []; }
}

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  analysis: {
    id: number;
    fileName: string;
    fileFormat: string;
    totalFeatures: number | null;
    errorCount: number | null;
    conformityScore: number;
    commune: string | null;
    region: string | null;
    geoJsonData: string | null;
  };
  errorIndex: Record<string, { errorType: string; severity: string }[]>;
}

export default function AnalysisTableClient({ user, analysis, errorIndex }: Props) {
  const [features, setFeatures] = useState<Feature[]>(() => parseFeatures(analysis.geoJsonData));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [filterErrors, setFilterErrors] = useState(false);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [showColPanel, setShowColPanel] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Detect columns
  const allColumns = useMemo(() => {
    const keySet = new Set<string>();
    features.slice(0, 200).forEach((f) => Object.keys(f.properties || {}).forEach((k) => keySet.add(k)));
    const priority = [
      "NICAD", "nicad", "NIC", "NUM_NICAD", "SUPERFICIE", "superficie",
      "COMMUNE", "commune", "REGION", "region", "PROPRIETAIRE", "proprietaire",
    ];
    return [...keySet].sort((a, b) => {
      const ai = priority.indexOf(a), bi = priority.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [features]);

  const visibleColumns = allColumns.filter((c) => !hiddenCols.has(c));

  const nicadKey = useMemo(
    () => ["NICAD", "nicad", "NIC", "NUM_NICAD"].find((k) => allColumns.includes(k)) ?? null,
    [allColumns]
  );

  const filtered = useMemo(() => {
    let rows = features;
    if (filterErrors) {
      rows = rows.filter((f) => {
        const nicad = nicadKey ? String(f.properties?.[nicadKey] ?? "") : "";
        return nicad && errorIndex[nicad]?.length > 0;
      });
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((f) =>
        Object.values(f.properties || {}).some((v) => String(v ?? "").toLowerCase().includes(q))
      );
    }
    return rows;
  }, [features, search, filterErrors, nicadKey, errorIndex]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageData = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageRowIds = pageData.map((f) => f._rowId);

  const pageAllSelected = pageRowIds.length > 0 && pageRowIds.every((id) => selected.has(id));
  const pagePartialSelected = !pageAllSelected && pageRowIds.some((id) => selected.has(id));

  const togglePageAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        pageRowIds.forEach((id) => next.delete(id));
      } else {
        pageRowIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleRow = (rowId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
  };

  const handleSearch = (v: string) => { setSearch(v); setPage(0); };
  const handleFilterErrors = () => { setFilterErrors((p) => !p); setPage(0); };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/features`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices: [...selected] }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? "Erreur serveur");
      }
      const toRemove = new Set(selected);
      setFeatures((prev) => prev.filter((f) => !toRemove.has(f._rowId)));
      setSelected(new Set());
      setShowDeleteModal(false);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setDeleting(false);
    }
  };

  const baseName = analysis.fileName.replace(/\.[^.]+$/, "");

  const handleExportCsv = () => {
    const header = ["#", ...visibleColumns].join(",");
    const rows = filtered.map((f, i) =>
      [i + 1, ...visibleColumns.map((c) => {
        const v = String(f.properties?.[c] ?? "");
        return v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
      })].join(",")
    );
    const csv = [header, ...rows].join("\n");
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `${baseName}_données.csv`);
  };

  const handleExportGeoJson = () => {
    const exportFeatures = filtered.map(({ _rowId, ...f }) => ({
      type: "Feature",
      geometry: f.geometry ?? null,
      properties: f.properties,
    }));
    const fc = { type: "FeatureCollection", features: exportFeatures };
    const json = JSON.stringify(fc, null, 2);
    triggerDownload(new Blob([json], { type: "application/geo+json;charset=utf-8;" }), `${baseName}_données.geojson`);
  };

  function triggerDownload(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <NavBar user={user} />

      <main className="flex-1 flex flex-col max-w-full px-6 py-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Link href={`/map/${analysis.id}`} className="text-muted-foreground hover:text-foreground transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </Link>
              <h1 className="text-lg font-bold truncate">{analysis.fileName}</h1>
              <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-secondary border border-border shrink-0">
                {analysis.fileFormat}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>{features.length.toLocaleString()} parcelles</span>
              <span className="text-red-400">{analysis.errorCount ?? 0} erreurs</span>
              <span className={toNum(analysis.conformityScore) >= 70 ? "text-green-400" : "text-orange-400"}>
                {toNum(analysis.conformityScore).toFixed(0)}% conformité
              </span>
              {(analysis.commune || analysis.region) && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {[analysis.commune, analysis.region].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link href={`/map/${analysis.id}`}>
              <Button size="sm" variant="outline" className="gap-1.5 h-8">
                <MapPin className="w-3.5 h-3.5" /> Carte
              </Button>
            </Link>
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8"
                onClick={() => setShowExportMenu((v) => !v)}
              >
                <Download className="w-3.5 h-3.5" />
                Exporter
                <ChevronDown className="w-3 h-3" />
              </Button>
              {showExportMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-xl z-20 py-1 overflow-hidden">
                    <button
                      onClick={() => { handleExportCsv(); setShowExportMenu(false); }}
                      className="cursor-pointer w-full text-left px-3 py-2 text-xs hover:bg-secondary/60 transition-colors flex items-center gap-2"
                    >
                      <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-secondary border border-border">CSV</span>
                      Tableur
                    </button>
                    <button
                      onClick={() => { handleExportGeoJson(); setShowExportMenu(false); }}
                      className="cursor-pointer w-full text-left px-3 py-2 text-xs hover:bg-secondary/60 transition-colors flex items-center gap-2"
                    >
                      <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-secondary border border-border">GeoJSON</span>
                      Carte / SIG
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Selection bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <span className="text-sm font-medium text-red-400">
              {selected.size.toLocaleString()} ligne{selected.size > 1 ? "s" : ""} sélectionnée{selected.size > 1 ? "s" : ""}
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="gap-1.5 h-7 ml-auto"
              onClick={() => { setDeleteError(null); setShowDeleteModal(true); }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Supprimer la sélection
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
              title="Désélectionner tout"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Rechercher dans toutes les colonnes..."
              className="pl-8 h-8 text-sm"
            />
            {search && (
              <button onClick={() => handleSearch("")} className="cursor-pointer absolute right-2.5 top-1/2 -translate-y-1/2">
                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>

          <Button
            size="sm"
            variant={filterErrors ? "default" : "outline"}
            className="gap-1.5 h-8"
            onClick={handleFilterErrors}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Avec erreurs
            {filterErrors && <X className="w-3 h-3 ml-1" />}
          </Button>

          <div className="relative">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8"
              onClick={() => setShowColPanel((v) => !v)}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Colonnes
              {hiddenCols.size > 0 && (
                <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-1">
                  {allColumns.length - hiddenCols.size}/{allColumns.length}
                </Badge>
              )}
            </Button>
            {showColPanel && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-card border border-border rounded-lg shadow-xl z-20 p-2 max-h-72 overflow-y-auto">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-xs font-medium">Colonnes visibles</span>
                  <button onClick={() => setHiddenCols(new Set())} className="cursor-pointer text-[10px] text-primary hover:underline">
                    Tout afficher
                  </button>
                </div>
                {allColumns.map((col) => (
                  <label key={col} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-secondary/50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hiddenCols.has(col)}
                      onChange={() => {
                        const next = new Set(hiddenCols);
                        if (next.has(col)) next.delete(col); else next.add(col);
                        setHiddenCols(next);
                      }}
                      className="w-3 h-3 accent-primary"
                    />
                    <span className="text-xs font-mono truncate">{col}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <span className="text-xs text-muted-foreground ml-auto">
            {filtered.length.toLocaleString()} lignes
            {filtered.length !== features.length && ` / ${features.length.toLocaleString()} total`}
          </span>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto rounded-lg border border-border">
          {features.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <FileText className="w-12 h-12 mb-3 opacity-30" />
              <p>Aucune donnée disponible</p>
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  {/* Select-all checkbox */}
                  <th className="px-3 py-2.5 w-10 border-r border-border/50">
                    <button
                      onClick={togglePageAll}
                      className="cursor-pointer flex items-center justify-center w-4 h-4 rounded border border-border hover:border-primary transition-colors"
                      title={pageAllSelected ? "Désélectionner la page" : "Sélectionner la page"}
                    >
                      {pageAllSelected ? (
                        <div className="w-2.5 h-2.5 bg-primary rounded-sm" />
                      ) : pagePartialSelected ? (
                        <Minus className="w-2.5 h-2.5 text-primary" />
                      ) : null}
                    </button>
                  </th>
                  <th className="text-left px-3 py-2.5 text-muted-foreground font-medium w-12 border-r border-border/50">#</th>
                  <th className="text-left px-3 py-2.5 text-muted-foreground font-medium w-24 border-r border-border/50">Erreurs</th>
                  {visibleColumns.map((col) => (
                    <th key={col} className="text-left px-3 py-2.5 text-muted-foreground font-medium whitespace-nowrap font-mono border-r border-border/50 last:border-r-0">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageData.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColumns.length + 3} className="text-center py-12 text-muted-foreground">
                      Aucun résultat
                    </td>
                  </tr>
                ) : (
                  pageData.map((feature, i) => {
                    const absIdx = safePage * PAGE_SIZE + i + 1;
                    const nicad = nicadKey ? String(feature.properties?.[nicadKey] ?? "") : "";
                    const errs = (nicad && errorIndex[nicad]) ? errorIndex[nicad] : [];
                    const worstSeverity = errs.find((e) => e.severity === "CRITICAL")?.severity
                      ?? errs.find((e) => e.severity === "HIGH")?.severity
                      ?? errs[0]?.severity;
                    const isSelected = selected.has(feature._rowId);

                    return (
                      <tr
                        key={feature._rowId}
                        onClick={() => toggleRow(feature._rowId)}
                        className={`border-b border-border/40 transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-primary/10 hover:bg-primary/15"
                            : worstSeverity === "CRITICAL" ? "bg-red-500/5 hover:bg-red-500/10"
                            : worstSeverity === "HIGH" ? "bg-orange-500/5 hover:bg-orange-500/10"
                            : worstSeverity ? "bg-yellow-500/5 hover:bg-yellow-500/10"
                            : "hover:bg-secondary/30"
                        }`}
                      >
                        {/* Row checkbox */}
                        <td className="px-3 py-2 border-r border-border/30" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => toggleRow(feature._rowId)}
                            className={`cursor-pointer flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                              isSelected ? "border-primary bg-primary" : "border-border hover:border-primary"
                            }`}
                          >
                            {isSelected && <div className="w-2 h-2 bg-primary-foreground rounded-sm" />}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground border-r border-border/30 tabular-nums">{absIdx}</td>
                        <td className="px-3 py-2 border-r border-border/30">
                          {errs.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {errs.slice(0, 2).map((e, ei) => (
                                <span key={ei} className={`text-[9px] font-mono ${SEVERITY_COLOR[e.severity] || "text-muted-foreground"}`}>
                                  {e.errorType}
                                </span>
                              ))}
                              {errs.length > 2 && (
                                <span className="text-[9px] text-muted-foreground">+{errs.length - 2}</span>
                              )}
                            </div>
                          ) : (
                            <CheckCircle className="w-3 h-3 text-green-500/50" />
                          )}
                        </td>
                        {visibleColumns.map((col) => {
                          const val = feature.properties?.[col];
                          return (
                            <td key={col} className="px-3 py-2 border-r border-border/30 last:border-r-0 max-w-[180px]">
                              <span className="truncate block" title={String(val ?? "")}>
                                {val == null || val === "" ? (
                                  <span className="text-muted-foreground/30">—</span>
                                ) : (
                                  String(val)
                                )}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-3 mt-1 border-t border-border shrink-0">
            <Button
              variant="outline" size="sm" className="gap-1.5 h-8"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Précédent
            </Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const pageIdx = totalPages <= 7 ? i : safePage <= 3 ? i : safePage >= totalPages - 4 ? totalPages - 7 + i : safePage - 3 + i;
                return (
                  <button
                    key={pageIdx}
                    onClick={() => setPage(pageIdx)}
                    className={`cursor-pointer w-7 h-7 rounded text-xs transition-colors ${
                      pageIdx === safePage ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {pageIdx + 1}
                  </button>
                );
              })}
            </div>
            <Button
              variant="outline" size="sm" className="gap-1.5 h-8"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
            >
              Suivant <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </main>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="font-semibold text-base">Supprimer les lignes</h3>
                <p className="text-sm text-muted-foreground">Cette action est irréversible.</p>
              </div>
            </div>

            <p className="text-sm mb-5">
              Vous allez supprimer{" "}
              <span className="font-semibold text-red-400">{selected.size.toLocaleString()} parcelle{selected.size > 1 ? "s" : ""}</span>{" "}
              du fichier <span className="font-mono text-xs">{analysis.fileName}</span>.
            </p>

            {deleteError && (
              <p className="text-xs text-red-400 mb-3 bg-red-500/10 px-3 py-2 rounded-lg">{deleteError}</p>
            )}

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline" size="sm"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
              >
                Annuler
              </Button>
              <Button
                variant="destructive" size="sm"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="gap-1.5"
              >
                {deleting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Suppression…
                  </span>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Confirmer la suppression
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
