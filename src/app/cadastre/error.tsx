"use client"; // Les error boundaries doivent être des Client Components

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Error boundary du module Cadastre : conserve la NavBar et la sidebar. */
export default function CadastreError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[cadastre/error-boundary]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-16">
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-bold tracking-tight">Le module Cadastre a rencontré une erreur</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message === "Opération réservée aux administrateurs."
            ? "Cette opération est réservée aux administrateurs."
            : "Le traitement n'a pas pu aboutir. Réessayez ; si le problème persiste, contactez l'administrateur."}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground/70">Réf. : {error.digest}</p>
        ) : null}
        <div className="mt-6">
          <Button onClick={reset} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Réessayer
          </Button>
        </div>
      </div>
    </div>
  );
}
