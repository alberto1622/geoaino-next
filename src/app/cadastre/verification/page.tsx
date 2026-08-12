"use client";
import { PageTitle } from "@/components/PageTitle";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  ShieldCheck,
  Search,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";
import { validateNicadFormat } from "@/lib/cadastre/nicad-logic";
import { verifierNicad } from "../_actions/nicad";

type VerifResult = Awaited<ReturnType<typeof verifierNicad>>;

export default function VerificationPage() {
  const [nicad, setNicad] = useState("");
  const [result, setResult] = useState<VerifResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Décomposition live (logique pure, exécutée côté client)
  const live = useMemo(() => validateNicadFormat(nicad), [nicad]);
  const cleaned = nicad.replace(/[\s\-_·]/g, "");

  function handleVerify() {
    if (!nicad.trim()) {
      toast.error("Veuillez saisir un NICAD à vérifier.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await verifierNicad({ nicad });
        setResult(res);
        // if (res.valid && res.existeEnDB) toast.success("NICAD valide et présent en base.");
        // else if (res.valid) toast.warning("NICAD au format valide mais absent de la base.");
        // else toast.error("NICAD invalide.");
      } catch {
        toast.error("Erreur lors de la vérification.");
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageTitle title="Vérification NICAD" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Vérification NICAD
          </h1>
          <p className="text-sm text-muted-foreground">
            Contrôle du format (16 caractères : Syscol×8 · Section×3 ·
            Parcelle×5) et de l&apos;existence en base.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saisir un NICAD</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={nicad}
              onChange={(e) => setNicad(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleVerify()}
              placeholder="0143012100100001"
              className="font-mono"
              maxLength={32}
            />
            <Button onClick={handleVerify} disabled={pending} className="gap-2">
              <Search className="h-4 w-4" />
              {pending ? "Vérification…" : "Vérifier"}
            </Button>
          </div>

          {/* Décomposition temps réel */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
            <p className="mb-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Décomposition ({cleaned.length}/16 caractères)
            </p>
            {cleaned.length === 16 ? (
              <NicadDisplay nicad={cleaned} size="lg" />
            ) : (
              <p className="text-sm text-muted-foreground">
                Saisissez 16 chiffres pour voir la décomposition Syscol ·
                Section · Parcelle.
              </p>
            )}
            {live.errors.length > 0 && cleaned.length > 0 && (
              <ul className="mt-3 space-y-1">
                {live.errors.map((e, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-1.5 text-xs text-rose-500"
                  >
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {result.valid ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              ) : (
                <XCircle className="h-5 w-5 text-rose-500" />
              )}
              Résultat de la vérification
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-xs text-muted-foreground">Format</p>
                <p
                  className={
                    result.formatValide ? "text-emerald-500" : "text-rose-500"
                  }
                >
                  {result.formatValide ? "Valide" : "Invalide"}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-xs text-muted-foreground">
                  En base de données
                </p>
                <p
                  className={
                    result.existeEnDB ? "text-emerald-500" : "text-amber-500"
                  }
                >
                  {result.existeEnDB ? "Présent" : "Absent"}
                </p>
              </div>
            </div>

            {result.valid && <NicadDisplay nicad={result.nicad} size="lg" />}

            {result.errors.length > 0 && (
              <ul className="space-y-1">
                {result.errors.map((e, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-1.5 text-rose-500"
                  >
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {e}
                  </li>
                ))}
              </ul>
            )}
            {result.warnings.length > 0 && (
              <ul className="space-y-1">
                {result.warnings.map((w, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-1.5 text-amber-500"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}

            {(result.commune2026 || result.details) && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Localisation &amp; détails
                </p>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  {result.commune2026 && (
                    <>
                      <span className="text-muted-foreground">Commune</span>
                      <span>{result.commune2026.nomCommune ?? "—"}</span>
                      <span className="text-muted-foreground">Département</span>
                      <span>{result.commune2026.departement ?? "—"}</span>
                      <span className="text-muted-foreground">Région</span>
                      <span>{result.commune2026.region ?? "—"}</span>
                    </>
                  )}
                  {result.details && (
                    <>
                      <span className="text-muted-foreground">Version</span>
                      <span>{result.details.version}</span>
                      <span className="text-muted-foreground">Statut</span>
                      <span>{result.details.statut}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
