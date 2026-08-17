"use client";
import { PageTitle } from "@/components/PageTitle";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { GitBranch, ArrowRight, Search, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";
import { listCommunes2026 } from "../_actions/communes";
import { basculerNicadAction, identifierBasculement } from "../_actions/nicad";

type Commune = { id: number; syscolPadded: string; nomCommune: string };
type Result = Awaited<ReturnType<typeof basculerNicadAction>>;
type Identification = Awaited<ReturnType<typeof identifierBasculement>>;

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function BasculementPage() {
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [nicadAncien, setNicadAncien] = useState("");
  const [syscolNouveau, setSyscolNouveau] = useState("");
  const [sectionNouvelle, setSectionNouvelle] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [identification, setIdentification] = useState<Identification | null>(null);
  const [pending, startTransition] = useTransition();
  const [identifying, startIdentifying] = useTransition();

  useEffect(() => {
    (async () => setCommunes((await listCommunes2026()) as Commune[]))();
  }, []);

  // Étape 1 — identification automatique : à partir du seul NICAD 2013, on
  // retrouve son Syscol, la correspondance 2026 (commune + section), et on
  // remonte toute différence (correspondance provisoire/absente, découpage,
  // fusion, rattachement de département, section absente en 2026). Pré-remplit
  // la commune 2026 cible si une correspondance a été trouvée — l'utilisateur
  // reste libre de la corriger avant de confirmer le basculement (étape 2).
  function handleIdentifier() {
    const nicad = nicadAncien.replace(/\D/g, "");
    if (nicad.length !== 16) {
      toast.error("Le NICAD d'origine doit comporter 16 chiffres.");
      return;
    }
    setResult(null);
    startIdentifying(async () => {
      try {
        const res = await identifierBasculement({ nicadAncien: nicad });
        setIdentification(res);
        if (!res.success) {
          toast.error(res.error ?? "Identification échouée.");
          return;
        }
        if (res.dejaAJour) {
          toast.success("Ce NICAD est déjà 2026 — aucun basculement nécessaire.");
          return;
        }
        if (res.proposition) {
          setSyscolNouveau(res.proposition.syscolNouveau);
          setSectionNouvelle(res.proposition.sectionNouvelle ?? "");
        }
        if (res.clean) toast.success("Correspondance 2026 identifiée sans différence.");
        else if (res.flags.length > 0) toast.warning(`${res.flags.length} différence(s) à vérifier.`);
      } catch {
        toast.error("Erreur lors de l'identification.");
      }
    });
  }

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

  // Un NICAD déjà 2026 n'a rien à basculer — masque le formulaire cible/section
  // plutôt que de laisser l'utilisateur "basculer" un NICAD qui l'est déjà.
  const dejaAJour = !!(identification?.success && identification.dejaAJour);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageTitle title="Basculement NICAD 2013-2026" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <GitBranch className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Basculement 2013 → 2026
          </h1>
          <p className="text-sm text-muted-foreground">
            Cas simple (Syscol seul) ou complexe (changement de section →
            nouvelle numérotation).
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paramètres</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              NICAD d&apos;origine (2013)
            </label>
            <div className="flex gap-2">
              <Input
                value={nicadAncien}
                onChange={(e) => {
                  setNicadAncien(e.target.value);
                  setIdentification(null);
                }}
                placeholder="0143012100100001"
                className="font-mono"
              />
              <Button
                variant="outline"
                onClick={handleIdentifier}
                disabled={identifying}
                className="shrink-0 gap-2"
              >
                <Search className="h-4 w-4" />
                {identifying ? "Identification…" : "Identifier"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Retrouve automatiquement la commune 2026 correspondante (Syscol,
              section, département) et signale toute différence avant de
              proposer un basculement.
            </p>
          </div>

          {identification && identification.success && identification.dejaAJour && (
            <div className="space-y-2 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Info className="h-4 w-4 shrink-0 text-blue-500" />
                {identification.commune2026?.nomCommune ?? "Commune 2026"}
              </div>
              <p className="text-xs text-muted-foreground">
                Ce Syscol correspond déjà à une commune 2026 — ce NICAD est
                à jour, aucun basculement n&apos;est nécessaire.
              </p>
              {identification.flags.length > 0 && (
                <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                  {identification.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {identification && identification.success && !identification.dejaAJour && (
            <div
              className={`space-y-2 rounded-lg border p-3 text-sm ${
                identification.clean
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-amber-500/40 bg-amber-500/5"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {identification.clean ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                )}
                {identification.commune2013?.nomCommune ?? "Commune 2013 introuvable"}
                {identification.correspondance?.nomCommune2026 && (
                  <>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {identification.correspondance.nomCommune2026}
                  </>
                )}
              </div>
              {identification.clean ? (
                <p className="text-xs text-muted-foreground">
                  Correspondance confirmée, commune inchangée, section retrouvée à
                  l&apos;identique — basculement simple proposé ci-dessous.
                </p>
              ) : (
                <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                  {identification.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {identification && !identification.success && (
            <p className="text-xs text-rose-500">{identification.error}</p>
          )}

          {!dejaAJour && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Commune 2026 cible
                    {identification?.success && identification.proposition && (
                      <span className="ml-1 font-normal text-primary">(pré-remplie)</span>
                    )}
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
                    {identification?.success && identification.proposition?.sectionNouvelle && (
                      <span className="ml-1 font-normal text-primary">
                        (identifiée par recouvrement spatial)
                      </span>
                    )}
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
            </>
          )}
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Résultat — cas {result.cas}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <NicadDisplay nicad={result.nicadAncien} />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <NicadDisplay nicad={result.nicadNouveau} />
            </div>
            <p className="text-xs text-muted-foreground">
              {result.description}
            </p>
          </CardContent>
        </Card>
      )}
      {result && !result.success && (
        <Card className="border-rose-500/40">
          <CardContent className="p-5 text-sm text-rose-500">
            {result.error}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
