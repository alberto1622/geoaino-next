"use client";
import { PageTitle } from "@/components/PageTitle";

import { useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Layers, Play, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import FieldMappingModal from "@/components/FieldMappingModal";
import { JobProgressSteps, type JobProgressStep } from "@/components/import/JobProgressSteps";
import { previewToutes, executerCommune, executerToutes, executerBasculementListe } from "../_actions/migration";

type Preview = {
  syscol2013: string;
  syscol2026: string | null;
  nomCommune2013: string;
  nomCommune2026: string | null;
  nbParcelles: number;
  statut: string;
};

type BasculeItem = {
  nicadAncien: string;
  dejaAJour: boolean;
  clean: boolean;
  flags: string[];
  proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
  commune2013?: string;
  commune2026?: string;
};
type BasculeReport = {
  kind: "bascule-nicad";
  items: BasculeItem[];
  stats: { total: number; invalides: number; dejaAJour: number; clean: number; avecDrapeaux: number };
};

const BASCULE_JOB_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "identify", label: "Identification des cibles 2026" },
];

export default function MigrationPage() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingInventory, setPendingInventory] = useState<{
    fileKey: string;
    fileName: string;
    targetFields: { key: string; label: string; aliases: string[]; required?: boolean }[];
    fields: { name: string; sampleValues: string[] }[];
    proposedMapping: Record<string, string>;
  } | null>(null);
  const [basculeJob, setBasculeJob] = useState<{
    id: number;
    status: string;
    phase: string | null;
    progress: number;
    error?: string | null;
  } | null>(null);
  const [basculeReport, setBasculeReport] = useState<BasculeReport | null>(null);
  const [selectedForBascule, setSelectedForBascule] = useState<Set<string>>(new Set());
  const [executingBascule, setExecutingBascule] = useState(false);

  function reload() {
    startTransition(async () => {
      try {
        setPreviews((await previewToutes()) as Preview[]);
      } catch {
        toast.error("Action non autorisée ou erreur de prévisualisation.");
      }
    });
  }

  useEffect(reload, []);

  const totalParcelles = previews.reduce((s, p) => s + p.nbParcelles, 0);

  function migrerCommune(p: Preview) {
    if (!p.syscol2026) return;
    setBusy(p.syscol2013);
    startTransition(async () => {
      try {
        const res = await executerCommune({ syscol2013: p.syscol2013, syscol2026: p.syscol2026! });
        toast.success(`${p.nomCommune2013} : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`);
        reload();
      } catch {
        toast.error("Échec de la migration.");
      } finally {
        setBusy(null);
      }
    });
  }

  function migrerToutes() {
    setBusy("ALL");
    startTransition(async () => {
      try {
        const res = await executerToutes();
        toast.success(`Migration globale : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`);
        reload();
      } catch {
        toast.error("Échec de la migration globale.");
      } finally {
        setBusy(null);
      }
    });
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const shpFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".dbf"));
    if (!shpFile || !dbfFile) {
      toast.error("Sélectionnez le .shp ET son .dbf ensemble.");
      e.target.value = "";
      return;
    }
    setBasculeReport(null);
    setBasculeJob(null);
    const fd = new FormData();
    fd.append("target", "bascule-nicad");
    for (const f of Array.from(files)) fd.append("files", f);
    try {
      const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: fd });
      const inv = await res.json();
      if (!res.ok) throw new Error(inv.error || "Inventaire échoué");
      setPendingInventory(inv);
    } catch (err) {
      toast.error(String(err));
    } finally {
      e.target.value = "";
    }
  }

  async function startBasculeJob(mapping: Record<string, string>) {
    if (!pendingInventory) return;
    const inv = pendingInventory;
    setPendingInventory(null);
    try {
      const res = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: inv.fileKey,
          fileName: inv.fileName,
          sourceType: "SHP",
          kind: "bascule-nicad",
          layerMapping: mapping,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import échoué");
      setBasculeJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
    }
  }

  useEffect(() => {
    if (!basculeJob || (basculeJob.status !== "pending" && basculeJob.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${basculeJob.id}`);
        const j = await res.json();
        setBasculeJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, error: j.error });
        if (j.status === "completed") {
          setBasculeReport(j.report as BasculeReport);
        } else if (j.status === "failed") {
          toast.error(j.error || "Échec de l'identification.");
        }
      } catch {
        // Prochain tick réessaiera — pas d'action sur une erreur réseau isolée.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [basculeJob]);

  function toggleSelected(nicad: string) {
    setSelectedForBascule((prev) => {
      const next = new Set(prev);
      if (next.has(nicad)) next.delete(nicad);
      else next.add(nicad);
      return next;
    });
  }

  function selectAllClean() {
    if (!basculeReport) return;
    setSelectedForBascule(new Set(basculeReport.items.filter((i) => i.clean).map((i) => i.nicadAncien)));
  }

  function executerSelection() {
    if (!basculeReport || selectedForBascule.size === 0) return;
    const items = basculeReport.items
      .filter((i) => selectedForBascule.has(i.nicadAncien) && i.proposition)
      .map((i) => ({
        nicadAncien: i.nicadAncien,
        syscolNouveau: i.proposition!.syscolNouveau,
        sectionNouvelle: i.proposition!.sectionNouvelle,
      }));
    setExecutingBascule(true);
    startTransition(async () => {
      try {
        const res = await executerBasculementListe({ items });
        toast.success(`${res.nbMigres} basculé(s), ${res.nbEchecs} échec(s).`);
        setSelectedForBascule(new Set());
        setBasculeReport(null);
        setBasculeJob(null);
      } catch (err) {
        toast.error(String(err));
      } finally {
        setExecutingBascule(false);
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Migration en masse" />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Migration en masse</h1>
            <p className="text-sm text-muted-foreground">
              Basculement des NICAD Syscol 2013 → 2026 par commune ou en global.
            </p>
          </div>
        </div>
        <Button onClick={migrerToutes} disabled={pending || previews.length === 0} className="gap-2">
          <Play className="h-4 w-4" /> Tout migrer
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <p className="text-2xl font-bold">{previews.length}</p>
            <p className="text-xs text-muted-foreground">Communes éligibles</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-2xl font-bold">{totalParcelles.toLocaleString("fr-FR")}</p>
            <p className="text-xs text-muted-foreground">Parcelles à migrer</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prévisualisation</CardTitle>
        </CardHeader>
        <CardContent>
          {previews.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucune commune éligible. Confirmez des correspondances 2013→2026 au préalable.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr className="border-b border-border/50">
                    <th className="py-2 pr-3">Commune 2013</th>
                    <th className="py-2 pr-3">→ Syscol 2026</th>
                    <th className="py-2 pr-3 text-right">Parcelles</th>
                    <th className="py-2 pr-3">Statut</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {previews.map((p) => (
                    <tr key={p.syscol2013} className="border-b border-border/30">
                      <td className="py-2 pr-3">{p.nomCommune2013}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{p.syscol2026 ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.nbParcelles.toLocaleString("fr-FR")}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{p.statut}</td>
                      <td className="py-2 pr-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => migrerCommune(p)}
                          disabled={pending || busy === p.syscol2013}
                        >
                          {busy === p.syscol2013 ? "…" : "Migrer"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Importer un shapefile (NICAD)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sélectionnez un shapefile (.shp + .dbf) portant une colonne NICAD
            2013 — la cible 2026 de chaque NICAD (commune, section, cas
            simple ou complexe) sera identifiée automatiquement avant tout
            basculement.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".shp,.dbf,.prj"
            onChange={handleFileSelected}
            className="hidden"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!basculeJob && basculeJob.status !== "completed" && basculeJob.status !== "failed"}
            className="gap-2"
          >
            <Upload className="h-4 w-4" /> Choisir un shapefile
          </Button>

          {basculeJob && (basculeJob.status === "pending" || basculeJob.status === "running") && (
            <JobProgressSteps
              steps={BASCULE_JOB_STEPS}
              phase={basculeJob.phase}
              status={basculeJob.status as "pending" | "running"}
              progress={basculeJob.progress}
            />
          )}

          {basculeReport && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{basculeReport.stats.total} ligne(s) lue(s)</span>
                <span>·</span>
                <span>{basculeReport.stats.clean} sans drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.avecDrapeaux} avec drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.dejaAJour} déjà à jour</span>
                <span>·</span>
                <span>{basculeReport.stats.invalides} invalide(s)</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAllClean}>
                  Sélectionner les lignes sans drapeau
                </Button>
                <Button
                  size="sm"
                  onClick={executerSelection}
                  disabled={selectedForBascule.size === 0 || executingBascule}
                  className="gap-2"
                >
                  <Play className="h-4 w-4" />
                  {executingBascule ? "Basculement…" : `Basculer la sélection (${selectedForBascule.size})`}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border/50">
                      <th className="py-2 pr-3" />
                      <th className="py-2 pr-3">NICAD ancien</th>
                      <th className="py-2 pr-3">→ Cible 2026</th>
                      <th className="py-2 pr-3">Statut</th>
                      <th className="py-2 pr-3">Drapeaux</th>
                    </tr>
                  </thead>
                  <tbody>
                    {basculeReport.items.map((item) => (
                      <tr
                        key={item.nicadAncien}
                        className={`border-b border-border/30 ${item.dejaAJour ? "opacity-50" : ""}`}
                      >
                        <td className="py-2 pr-3">
                          {!item.dejaAJour && item.proposition && (
                            <input
                              type="checkbox"
                              checked={selectedForBascule.has(item.nicadAncien)}
                              onChange={() => toggleSelected(item.nicadAncien)}
                            />
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{item.nicadAncien}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {item.proposition
                            ? `${item.proposition.syscolNouveau}${item.proposition.sectionNouvelle ? " / section " + item.proposition.sectionNouvelle : ""}`
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {item.dejaAJour ? "Déjà 2026" : item.clean ? "Sans drapeau" : "Avec drapeau"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {item.flags.length > 0 ? item.flags.join(" · ") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {pendingInventory && (
        <FieldMappingModal
          fileName={pendingInventory.fileName}
          targetFields={pendingInventory.targetFields}
          availableFields={pendingInventory.fields}
          proposedMapping={pendingInventory.proposedMapping}
          onCancel={() => setPendingInventory(null)}
          onConfirm={(mapping) => void startBasculeJob(mapping)}
        />
      )}
    </div>
  );
}
