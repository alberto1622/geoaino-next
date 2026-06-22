"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportDonnees } from "../_actions/import-export";

type TypeExport = "nicads" | "historique" | "communes2013" | "communes2026";
type Format = "csv" | "json";

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function ExportPage() {
  const [typeExport, setTypeExport] = useState<TypeExport>("nicads");
  const [format, setFormat] = useState<Format>("csv");
  const [includeGeom, setIncludeGeom] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleExport() {
    startTransition(async () => {
      try {
        const res = await exportDonnees({ typeExport, format, includeGeom });
        if (!res.success || !res.contenu) {
          toast.error(res.success ? "Aucune donnée à exporter." : (res as { error?: string }).error ?? "Échec de l'export.");
          return;
        }
        const blob = new Blob([res.contenu], {
          type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `export_${typeExport}_${new Date().toISOString().slice(0, 10)}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`${res.nbEntites} enregistrement(s) exporté(s).`);
      } catch {
        toast.error("Erreur lors de l'export.");
      }
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Download className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Export de données</h1>
          <p className="text-sm text-muted-foreground">Exporter le référentiel en CSV ou JSON.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paramètres d&apos;export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Type</label>
              <select className={selectCls} value={typeExport} onChange={(e) => setTypeExport(e.target.value as TypeExport)}>
                <option value="nicads">NICAD</option>
                <option value="historique">Historique des basculements</option>
                <option value="communes2013">Communes 2013</option>
                <option value="communes2026">Communes 2026</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Format</label>
              <select className={selectCls} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
          </div>

          {(typeExport === "communes2013" || typeExport === "communes2026") && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeGeom} onChange={(e) => setIncludeGeom(e.target.checked)} />
              Inclure les géométries (GeoJSON)
            </label>
          )}

          <Button onClick={handleExport} disabled={pending} className="gap-2">
            <Download className="h-4 w-4" />
            {pending ? "Export…" : "Télécharger"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
