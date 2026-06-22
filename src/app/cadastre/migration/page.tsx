"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Layers, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { previewToutes, executerCommune, executerToutes } from "../_actions/migration";

type Preview = {
  syscol2013: string;
  syscol2026: string | null;
  nomCommune2013: string;
  nomCommune2026: string | null;
  nbParcelles: number;
  statut: string;
};

export default function MigrationPage() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
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
    </div>
  );
}
