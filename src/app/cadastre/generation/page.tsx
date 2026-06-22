"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Sparkles, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";
import { listCommunes2013, listCommunes2026 } from "../_actions/communes";
import { listSectionsByCommune } from "../_actions/sections";
import { genererNicad } from "../_actions/nicad";

type Version = "2013" | "2026";
type Commune = { id: number; syscolPadded: string; nomCommune: string; region?: string | null };
type Section = { numSection: string; nomSection?: string | null };
type GenResult = Awaited<ReturnType<typeof genererNicad>>;

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function GenerationPage() {
  const [version, setVersion] = useState<Version>("2013");
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [syscol, setSyscol] = useState("");
  const [section, setSection] = useState("");
  const [numParcelleExistant, setNumParcelleExistant] = useState("");
  const [nomProprietaire, setNomProprietaire] = useState("");
  const [result, setResult] = useState<GenResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Charger les communes selon la version
  useEffect(() => {
    setSyscol("");
    setSection("");
    setSections([]);
    (async () => {
      const list = version === "2013" ? await listCommunes2013() : await listCommunes2026();
      setCommunes(list as Commune[]);
    })();
  }, [version]);

  // Charger les sections de la commune sélectionnée
  useEffect(() => {
    setSection("");
    if (!syscol) {
      setSections([]);
      return;
    }
    (async () => {
      const list = await listSectionsByCommune({ syscol, version });
      setSections(list as Section[]);
    })();
  }, [syscol, version]);

  function handleGenerate() {
    if (!syscol || !section) {
      toast.error("Sélectionnez une commune et une section.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await genererNicad({
          syscol,
          section,
          version,
          numParcelleExistant: numParcelleExistant || undefined,
          nomProprietaire: nomProprietaire || undefined,
        });
        setResult(res);
        if (res.success) toast.success(`NICAD généré : ${res.nicad}`);
        else toast.error(res.error ?? "Échec de la génération.");
      } catch {
        toast.error("Erreur lors de la génération.");
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Génération NICAD</h1>
          <p className="text-sm text-muted-foreground">
            Attribution d&apos;un NICAD par numérotation séquentielle dans la section choisie.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paramètres</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Version Syscol</label>
            <div className="flex gap-2">
              {(["2013", "2026"] as Version[]).map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant={version === v ? "default" : "outline"}
                  size="sm"
                  onClick={() => setVersion(v)}
                >
                  Syscol {v}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Commune ({communes.length})
              </label>
              <select className={selectCls} value={syscol} onChange={(e) => setSyscol(e.target.value)}>
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
                Section ({sections.length})
              </label>
              <select
                className={selectCls}
                value={section}
                onChange={(e) => setSection(e.target.value)}
                disabled={!syscol}
              >
                <option value="">— Sélectionner —</option>
                {sections.map((s) => (
                  <option key={s.numSection} value={s.numSection}>
                    {s.numSection}
                    {s.nomSection ? ` — ${s.nomSection}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                N° parcelle existante (optionnel)
              </label>
              <Input
                value={numParcelleExistant}
                onChange={(e) => setNumParcelleExistant(e.target.value)}
                placeholder="ex. 00012"
                className="font-mono"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Propriétaire (optionnel)
              </label>
              <Input
                value={nomProprietaire}
                onChange={(e) => setNomProprietaire(e.target.value)}
                placeholder="Nom du propriétaire"
              />
            </div>
          </div>

          <Button onClick={handleGenerate} disabled={pending || !syscol || !section} className="gap-2">
            <Sparkles className="h-4 w-4" />
            {pending ? "Génération…" : "Générer le NICAD"}
          </Button>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" /> NICAD généré
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <NicadDisplay nicad={result.nicad} size="lg" />
            <div className="grid grid-cols-2 gap-1 text-xs">
              <span className="text-muted-foreground">Commune</span>
              <span>{result.commune?.nom}</span>
              <span className="text-muted-foreground">Section</span>
              <span>
                {result.section?.num}
                {result.section?.nom ? ` — ${result.section.nom}` : ""}
              </span>
              <span className="text-muted-foreground">Numérotation</span>
              <span>{result.numerotation?.message}</span>
            </div>
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
