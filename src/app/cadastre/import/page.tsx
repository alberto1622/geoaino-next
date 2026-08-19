"use client";
import { PageTitle } from "@/components/PageTitle";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload, FileUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import FieldMappingModal from "@/components/FieldMappingModal";
import { JobProgressSteps, type JobProgressStep } from "@/components/import/JobProgressSteps";
import { uploadShapefile } from "../_actions/import-export";
import type { TargetFieldDef, ShapefileTarget } from "@/lib/import/field-mapping";

type TypeImport = "parcelles" | "sections" | "communes2013" | "communes2026" | "nicads";

const TYPES: { value: TypeImport; label: string; hint: string }[] = [
  { value: "parcelles", label: "Parcelles", hint: ".shp + .dbf (ou .geojson) — NICAD 16 ou Codesectio 11" },
  { value: "sections", label: "Sections", hint: ".shp + .dbf — Num_sect_N (11 chiffres)" },
  { value: "communes2013", label: "Communes 2013", hint: ".shp + .dbf / .geojson / .csv — Syscol" },
  { value: "communes2026", label: "Communes 2026", hint: ".shp + .dbf / .geojson / .csv — COD_SYSCOL" },
  { value: "nicads", label: "NICAD (CSV)", hint: ".csv — colonne NICAD (16 caractères)" },
];

/** Ces deux types seulement passent par l'inventaire + mappage + job asynchrone ; les autres restent synchrones. */
const MAPPED_TYPES = new Set<TypeImport>(["parcelles", "sections"]);

function targetForType(t: TypeImport): ShapefileTarget {
  return t === "sections" ? "cad-sections" : "cad-parcelles";
}
function kindForType(t: TypeImport): "cad-parcelles" | "cad-sections" {
  return t === "sections" ? "cad-sections" : "cad-parcelles";
}

interface ShapefileInventoryResponse {
  fileKey: string;
  fileName: string;
  featureCount: number;
  fields: { name: string; sampleValues: string[] }[];
  targetFields: TargetFieldDef[];
  proposedMapping: Record<string, string>;
}

interface JobState {
  id: number;
  status: string;
  phase: string | null;
  progress: number;
  report?: { nbImportes?: number; nbIgnores?: number; nbErreurs?: number; warnings?: string[] } | null;
  error?: string | null;
}

/** Pipeline shapefile cad-parcelles/cad-sections (`run-shapefile-job.ts`) : lecture puis import batché. */
const CAD_IMPORT_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "import", label: "Import des entités" },
];

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      resolve(res.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ImportPage() {
  const [typeImport, setTypeImport] = useState<TypeImport>("parcelles");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof uploadShapefile>> | null>(null);
  const [inventory, setInventory] = useState<ShapefileInventoryResponse | null>(null);
  const [job, setJob] = useState<JobState | null>(null);

  const isMapped = MAPPED_TYPES.has(typeImport);
  const isShapefileSelected = files.some((f) => f.name.toLowerCase().endsWith(".shp"));
  const jobRunning = job?.status === "pending" || job?.status === "running";

  // ── Polling du job (mêmes phases/format que le job DXF) ────────────────────
  useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.id}`, { cache: "no-store" });
        const j = await res.json();
        setJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, report: j.report, error: j.error });
        if (j.status === "completed") {
          setResult({
            success: true,
            nbImportes: j.report?.nbImportes ?? j.totalBuilt ?? 0,
            nbIgnores: j.report?.nbIgnores,
            nbErreurs: j.report?.nbErreurs,
            warnings: j.report?.warnings,
          });
          toast.success(`${j.report?.nbImportes ?? j.totalBuilt ?? 0} entité(s) importée(s).`);
        } else if (j.status === "failed") {
          toast.error(j.error || "Import échoué.");
        } else if (j.status === "cancelled") {
          toast.info("Import annulé.");
        }
      } catch {
        /* réessaie au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job]);

  const handleCancel = useCallback(async () => {
    if (!job) return;
    await fetch(`/api/import-jobs/${job.id}/cancel`, { method: "POST" });
  }, [job]);

  async function startMappedJob(mapping: Record<string, string>) {
    if (!inventory) return;
    const inv = inventory;
    setInventory(null);
    try {
      const res = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: inv.fileKey,
          fileName: inv.fileName,
          sourceType: "SHP",
          kind: kindForType(typeImport),
          layerMapping: mapping,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(e.error || `Erreur serveur: ${res.status}`);
      }
      const { jobId } = (await res.json()) as { jobId: number };
      setResult(null);
      setJob({ id: jobId, status: "pending", phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
    }
  }

  function handleImport() {
    if (files.length === 0) {
      toast.error("Sélectionnez au moins un fichier.");
      return;
    }

    if (isMapped && isShapefileSelected) {
      const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
      const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
      if (!shpFile || !dbfFile) {
        toast.error("Sélectionnez le .shp ET son .dbf ensemble.");
        return;
      }
      startTransition(async () => {
        try {
          const fd = new FormData();
          fd.append("target", targetForType(typeImport));
          fd.append("files", shpFile);
          fd.append("files", dbfFile);
          const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Inventaire échoué.");
          setInventory(data);
        } catch (err) {
          toast.error(String(err));
        }
      });
      return;
    }

    startTransition(async () => {
      try {
        const fichiers = await Promise.all(
          files.map(async (f) => ({ nom: f.name, contenu: await fileToBase64(f) })),
        );
        const res = await uploadShapefile({ typeImport, fichiers });
        setResult(res);
        if (res.success) toast.success(`${res.nbImportes} entité(s) importée(s).`);
        else toast.error(res.error ?? "Échec de l'import.");
      } catch {
        toast.error("Erreur lors de l'import.");
      }
    });
  }

  const hint = TYPES.find((t) => t.value === typeImport)?.hint;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="Import de données" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Upload className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import de données</h1>
          <p className="text-sm text-muted-foreground">Shapefile (.shp + .dbf), GeoJSON ou CSV.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fichier à importer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Type d&apos;import</label>
            <select
              className={selectCls}
              value={typeImport}
              onChange={(e) => setTypeImport(e.target.value as TypeImport)}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 p-6 text-center hover:bg-secondary/40">
            <FileUp className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {files.length > 0 ? `${files.length} fichier(s) sélectionné(s)` : "Cliquez pour choisir des fichiers"}
            </span>
            <input
              type="file"
              multiple
              accept=".shp,.dbf,.geojson,.json,.csv"
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length > 0 && (
            <ul className="text-xs text-muted-foreground">
              {files.map((f) => (
                <li key={f.name}>• {f.name}</li>
              ))}
            </ul>
          )}

          <Button onClick={handleImport} disabled={pending || jobRunning} className="gap-2">
            <Upload className="h-4 w-4" />
            {pending ? "Préparation…" : jobRunning ? "Import en cours…" : "Importer"}
          </Button>
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardContent className="space-y-3 p-5 text-sm">
            <JobProgressSteps
              steps={CAD_IMPORT_STEPS}
              phase={job.phase}
              status={job.status as "pending" | "running" | "completed" | "failed" | "cancelled"}
              progress={job.progress}
            />
            {jobRunning && (
              <div className="text-center">
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Annuler
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className={result.success ? "" : "border-rose-500/40"}>
          <CardContent className="space-y-1 p-5 text-sm">
            {result.success ? (
              <>
                <p className="font-medium text-emerald-500">Import terminé</p>
                <p>Importées : {result.nbImportes}</p>
                {"nbIgnores" in result && result.nbIgnores != null && <p>Ignorées : {result.nbIgnores}</p>}
                {"nbErreurs" in result && result.nbErreurs != null && <p>Erreurs : {result.nbErreurs}</p>}
                {"warnings" in result && result.warnings && result.warnings.length > 0 && (
                  <ul className="mt-2 text-xs text-amber-500">
                    {result.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-rose-500">{result.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {inventory && (
        <FieldMappingModal
          fileName={inventory.fileName}
          targetFields={inventory.targetFields}
          availableFields={inventory.fields}
          proposedMapping={inventory.proposedMapping}
          onCancel={() => setInventory(null)}
          onConfirm={(mapping) => void startMappedJob(mapping)}
        />
      )}
    </div>
  );
}
