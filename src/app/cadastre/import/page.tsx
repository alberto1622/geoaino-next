"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload, FileUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { uploadShapefile } from "../_actions/import-export";

type TypeImport = "parcelles" | "sections" | "communes2013" | "communes2026" | "nicads";

const TYPES: { value: TypeImport; label: string; hint: string }[] = [
  { value: "parcelles", label: "Parcelles", hint: ".shp + .dbf (ou .geojson) — NICAD 16 ou Codesectio 11" },
  { value: "sections", label: "Sections", hint: ".shp + .dbf — Num_sect_N (11 chiffres)" },
  { value: "communes2013", label: "Communes 2013", hint: ".shp + .dbf / .geojson / .csv — Syscol" },
  { value: "communes2026", label: "Communes 2026", hint: ".shp + .dbf / .geojson / .csv — COD_SYSCOL" },
  { value: "nicads", label: "NICAD (CSV)", hint: ".csv — colonne NICAD (16 caractères)" },
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

  function handleImport() {
    if (files.length === 0) {
      toast.error("Sélectionnez au moins un fichier.");
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

          <Button onClick={handleImport} disabled={pending} className="gap-2">
            <Upload className="h-4 w-4" />
            {pending ? "Import en cours…" : "Importer"}
          </Button>
        </CardContent>
      </Card>

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
    </div>
  );
}
