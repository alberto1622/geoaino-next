"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { GitBranch, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";
import { listCommunes2026 } from "../_actions/communes";
import { basculerNicadAction } from "../_actions/nicad";

type Commune = { id: number; syscolPadded: string; nomCommune: string };
type Result = Awaited<ReturnType<typeof basculerNicadAction>>;

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function BasculementPage() {
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [nicadAncien, setNicadAncien] = useState("");
  const [syscolNouveau, setSyscolNouveau] = useState("");
  const [sectionNouvelle, setSectionNouvelle] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    (async () => setCommunes((await listCommunes2026()) as Commune[]))();
  }, []);

  function handleBascule() {
    if (nicadAncien.replace(/\D/g, "").length !== 16) {
      toast.error("Le NICAD d'origine doit comporter 16 chiffres.");
      return;
    }
    if (!syscolNouveau) {
      toast.error("Sélectionnez la commune 2026 cible.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await basculerNicadAction({
          nicadAncien: nicadAncien.replace(/\D/g, ""),
          syscolNouveau,
          sectionNouvelle: sectionNouvelle || undefined,
        });
        setResult(res);
        if (res.success) toast.success(`Basculement ${res.cas} effectué.`);
        else toast.error(res.error ?? "Échec du basculement.");
      } catch {
        toast.error("Erreur lors du basculement.");
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <GitBranch className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Basculement 2013 → 2026</h1>
          <p className="text-sm text-muted-foreground">
            Cas simple (Syscol seul) ou complexe (changement de section → nouvelle numérotation).
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paramètres</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">NICAD d&apos;origine (2013)</label>
            <Input
              value={nicadAncien}
              onChange={(e) => setNicadAncien(e.target.value)}
              placeholder="0143012100100001"
              className="font-mono"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Commune 2026 cible
              </label>
              <select
                className={selectCls}
                value={syscolNouveau}
                onChange={(e) => setSyscolNouveau(e.target.value)}
              >
                <option value="">— Sélectionner —</option>
                {communes.map((c) => (
                  <option key={c.id} value={c.syscolPadded}>
                    {c.nomCommune} ({c.syscolPadded})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Nouvelle section (cas complexe, optionnel)
              </label>
              <Input
                value={sectionNouvelle}
                onChange={(e) => setSectionNouvelle(e.target.value)}
                placeholder="ex. 002"
                className="font-mono"
              />
            </div>
          </div>
          <Button onClick={handleBascule} disabled={pending} className="gap-2">
            <GitBranch className="h-4 w-4" />
            {pending ? "Basculement…" : "Basculer le NICAD"}
          </Button>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Résultat — cas {result.cas}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <NicadDisplay nicad={result.nicadAncien} />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <NicadDisplay nicad={result.nicadNouveau} />
            </div>
            <p className="text-xs text-muted-foreground">{result.description}</p>
          </CardContent>
        </Card>
      )}
      {result && !result.success && (
        <Card className="border-rose-500/40">
          <CardContent className="p-5 text-sm text-rose-500">{result.error}</CardContent>
        </Card>
      )}
    </div>
  );
}
