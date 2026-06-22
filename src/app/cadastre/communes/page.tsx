"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Building2, Download, FileArchive } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listCommunes2013ByRegion,
  listCommunes2026,
  listRegions2013,
  listRegions2026,
} from "../_actions/communes";
import { parcellesCount } from "../_actions/carte";

type Version = "2013" | "2026";
type Commune = {
  id: number;
  syscolPadded: string;
  nomCommune: string;
  region?: string | null;
  departement?: string | null;
};

const selectCls =
  "h-9 rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function CommunesPage() {
  const [version, setVersion] = useState<Version>("2026");
  const [regions, setRegions] = useState<string[]>([]);
  const [region, setRegion] = useState("");
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      setRegions(version === "2013" ? await listRegions2013() : await listRegions2026());
      setRegion("");
    })();
  }, [version]);

  useEffect(() => {
    (async () => {
      const list =
        version === "2013"
          ? ((await listCommunes2013ByRegion({ region: region || undefined })) as Commune[])
          : ((await listCommunes2026({ region: region || undefined })) as Commune[]);
      setCommunes(list);
    })();
  }, [version, region]);

  useEffect(() => {
    (async () => setCounts(await parcellesCount()))();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return communes;
    return communes.filter(
      (c) => c.nomCommune.toLowerCase().includes(q) || c.syscolPadded.includes(q),
    );
  }, [communes, search]);

  function exportCsv() {
    if (filtered.length === 0) {
      toast.error("Aucune commune à exporter.");
      return;
    }
    const headers = ["syscol", "nomCommune", "region", "departement", "nbParcelles"];
    const lines = [
      headers.join(";"),
      ...filtered.map((c) =>
        [c.syscolPadded, c.nomCommune, c.region ?? "", c.departement ?? "", counts[c.syscolPadded] ?? 0].join(";"),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `communes_${version}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Communes</h1>
          <p className="text-sm text-muted-foreground">Référentiel Syscol 2013 et 2026.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{filtered.length} commune(s)</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {(["2013", "2026"] as Version[]).map((v) => (
              <Button key={v} variant={version === v ? "default" : "outline"} size="sm" onClick={() => setVersion(v)}>
                Syscol {v}
              </Button>
            ))}
            <select className={selectCls} value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Toutes régions</option>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="h-9 w-40"
            />
            <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1.5">
              <Download className="h-4 w-4" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border/50">
                  <th className="py-2 pr-3">Syscol</th>
                  <th className="py-2 pr-3">Commune</th>
                  <th className="py-2 pr-3">Région</th>
                  <th className="py-2 pr-3">Département</th>
                  <th className="py-2 pr-3 text-right">Parcelles</th>
                  <th className="py-2 pr-3 text-right">Export</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-border/30">
                    <td className="py-2 pr-3 font-mono text-xs">{c.syscolPadded}</td>
                    <td className="py-2 pr-3">{c.nomCommune}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{c.region ?? "—"}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{c.departement ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {(counts[c.syscolPadded] ?? 0).toLocaleString("fr-FR")}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <a
                        href={`/api/cadastre/export/shapefile/${c.syscolPadded}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <FileArchive className="h-3.5 w-3.5" /> ZIP
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
