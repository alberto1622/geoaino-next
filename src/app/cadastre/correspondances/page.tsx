"use client";
import { PageTitle } from "@/components/PageTitle";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { GitMerge, CheckCheck, RefreshCw, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listCorrespondances,
  confirmerToutes,
  initCorrespondances,
  recalculerCorrespondances,
  upsertCorrespondanceAction,
} from "../_actions/correspondance";

type Statut = "confirme" | "provisoire" | "sans_correspondance";
type Correspondance = {
  id: number;
  syscol2013: string;
  nomCommune2013: string;
  syscol2026: string | null;
  nomCommune2026: string | null;
  region: string | null;
  departement: string | null;
  departement2026: string | null;
  statut: string;
  typeChangement: string | null;
  nbCibles2026: number;
  nbSources2013: number;
  cibles2026: string | null;
};

const selectCls =
  "h-9 rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const badge = (s: string) =>
  s === "confirme"
    ? "bg-emerald-500/15 text-emerald-500"
    : s === "provisoire"
      ? "bg-amber-500/15 text-amber-500"
      : "bg-rose-500/15 text-rose-500";

const TYPE_LABEL: Record<string, string> = {
  inchange: "Inchangé",
  renomme: "Renommé",
  rattachement_departement: "Chgt département",
  decoupe: "Découpé",
  fusion: "Fusionné",
  disparue: "Sans corresp.",
};

const typeBadge = (t: string | null) => {
  switch (t) {
    case "decoupe":
      return "bg-orange-500/15 text-orange-500";
    case "fusion":
      return "bg-purple-500/15 text-purple-500";
    case "rattachement_departement":
      return "bg-rose-500/15 text-rose-500";
    case "renomme":
      return "bg-blue-500/15 text-blue-500";
    case "disparue":
      return "bg-zinc-500/15 text-zinc-400";
    default:
      return "bg-zinc-500/10 text-muted-foreground";
  }
};

/** Vrai si le code Syscol lui-même diffère entre 2013 et 2026 — INDÉPENDANT
 *  de `typeChangement` : ce dernier reflète un changement de nom/géométrie/
 *  rattachement, jamais une simple recodification. Une commune classée
 *  "inchange" (même nom, même emprise) peut très bien avoir été recodée lors
 *  de la refonte 2013→2026 (ex. Golf Sud : 01430111 → 01430121) — invisible
 *  tant qu'on ne compare pas explicitement les deux codes. */
function syscolChanged(c: Correspondance): boolean {
  return !!c.syscol2026 && c.syscol2026 !== c.syscol2013;
}

export default function CorrespondancesPage() {
  const [rows, setRows] = useState<Correspondance[]>([]);
  const [statut, setStatut] = useState<"" | Statut>("");
  const [typeChangement, setTypeChangement] = useState("");
  const [search, setSearch] = useState("");
  const [syscolChangeOnly, setSyscolChangeOnly] = useState(false);
  const [pending, startTransition] = useTransition();
  const displayedRows = syscolChangeOnly ? rows.filter(syscolChanged) : rows;
  const nbSyscolChanged = rows.filter(syscolChanged).length;

  async function reload() {
    const list = (await listCorrespondances({
      statut: statut || undefined,
      typeChangement: typeChangement || undefined,
      search: search || undefined,
      limit: 500,
    })) as Correspondance[];
    setRows(list);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statut, typeChangement]);

  function handleConfirmAll() {
    startTransition(async () => {
      try {
        const { nb } = await confirmerToutes();
        toast.success(`${nb} correspondance(s) confirmée(s).`);
        reload();
      } catch {
        toast.error("Action non autorisée ou erreur.");
      }
    });
  }

  function handleInit() {
    startTransition(async () => {
      try {
        const res = await initCorrespondances();
        toast.success(`${res.inserted} créée(s), ${res.skipped} déjà présentes.`);
        reload();
      } catch {
        toast.error("Action non autorisée ou erreur.");
      }
    });
  }

  function handleRecalcul() {
    startTransition(async () => {
      try {
        const res = await recalculerCorrespondances();
        const detail = Object.entries(res.parType)
          .map(([t, n]) => `${TYPE_LABEL[t] ?? t}: ${n}`)
          .join(", ");
        toast.success(`${res.total} commune(s) analysée(s). ${detail}`);
        reload();
      } catch {
        toast.error("Action non autorisée ou erreur.");
      }
    });
  }

  function confirmOne(c: Correspondance) {
    startTransition(async () => {
      try {
        await upsertCorrespondanceAction({
          syscol2013: c.syscol2013,
          nomCommune2013: c.nomCommune2013,
          syscol2026: c.syscol2026 ?? undefined,
          nomCommune2026: c.nomCommune2026 ?? undefined,
          statut: "confirme",
        });
        reload();
      } catch {
        toast.error("Action non autorisée.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Correspondances 2013-2026" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <GitMerge className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Correspondances 2013 → 2026</h1>
          <p className="text-sm text-muted-foreground">Mise en correspondance des codes Syscol.</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{displayedRows.length} correspondance(s)</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <select className={selectCls} value={statut} onChange={(e) => setStatut(e.target.value as Statut | "")} aria-label="Filtrer par statut">
              <option value="">Tous statuts</option>
              <option value="confirme">Confirmées</option>
              <option value="provisoire">Provisoires</option>
              <option value="sans_correspondance">Sans correspondance</option>
            </select>
            <select className={selectCls} value={typeChangement} onChange={(e) => setTypeChangement(e.target.value)} aria-label="Filtrer par type de changement">
              <option value="">Tous types</option>
              <option value="inchange">Inchangé</option>
              <option value="renomme">Renommé</option>
              <option value="rattachement_departement">Chgt département</option>
              <option value="decoupe">Découpé</option>
              <option value="fusion">Fusionné</option>
              <option value="disparue">Sans correspondance</option>
            </select>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && reload()}
              placeholder="Rechercher…"
              className="h-9 w-40"
            />
            <label
              className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm"
              title="N'afficher que les communes dont le code Syscol diffère entre 2013 et 2026 — y compris celles classées « Inchangé » (même nom/emprise, code recodifié)"
            >
              <input
                type="checkbox"
                checked={syscolChangeOnly}
                onChange={(e) => setSyscolChangeOnly(e.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
              />
              Syscol changé
              {nbSyscolChanged > 0 && (
                <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                  {nbSyscolChanged}
                </span>
              )}
            </label>
            <Button variant="outline" size="sm" onClick={handleInit} disabled={pending} className="gap-1.5">
              <RefreshCw className="h-4 w-4" /> Initialiser
            </Button>
            <Button variant="outline" size="sm" onClick={handleRecalcul} disabled={pending} className="gap-1.5">
              <Layers className="h-4 w-4" /> Recalcul spatial
            </Button>
            <Button size="sm" onClick={handleConfirmAll} disabled={pending} className="gap-1.5">
              <CheckCheck className="h-4 w-4" /> Confirmer toutes
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border/50">
                  <th className="py-2 pr-3">Syscol 2013</th>
                  <th className="py-2 pr-3">Commune 2013</th>
                  <th className="py-2 pr-3">Syscol 2026</th>
                  <th className="py-2 pr-3">Commune 2026</th>
                  <th className="py-2 pr-3">Changement</th>
                  <th className="py-2 pr-3">Statut</th>
                  <th className="py-2 pr-3" />
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((c) => {
                  const scChanged = syscolChanged(c);
                  return (
                  <tr key={c.id} className="border-b border-border/30">
                    <td className="py-2 pr-3 font-mono text-xs">{c.syscol2013}</td>
                    <td className="py-2 pr-3">{c.nomCommune2013}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          scChanged
                            ? "rounded bg-blue-500/15 px-1.5 py-0.5 font-mono text-xs text-blue-500"
                            : "font-mono text-xs"
                        }
                        title={
                          scChanged
                            ? `Syscol changé : ${c.syscol2013} (2013) → ${c.syscol2026} (2026)`
                            : undefined
                        }
                      >
                        {c.syscol2026 ?? "—"}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{c.nomCommune2026 ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {c.typeChangement ? (
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${typeBadge(c.typeChangement)}`}
                          title={
                            [
                              c.departement2026 && c.departement2026 !== c.departement
                                ? `${c.departement ?? "?"} → ${c.departement2026}`
                                : "",
                              c.cibles2026 ?? "",
                            ]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          }
                        >
                          {TYPE_LABEL[c.typeChangement] ?? c.typeChangement}
                          {c.typeChangement === "decoupe" && c.nbCibles2026 > 1 ? ` ×${c.nbCibles2026}` : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`rounded px-2 py-0.5 text-xs ${badge(c.statut)}`}>{c.statut}</span>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {c.statut === "provisoire" && c.syscol2026 ? (
                        <Button variant="ghost" size="sm" onClick={() => confirmOne(c)} disabled={pending}>
                          Confirmer
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
