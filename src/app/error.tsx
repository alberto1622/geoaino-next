"use client"; // Les error boundaries doivent être des Client Components

import { useEffect } from "react";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error-boundary]", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">Une erreur est survenue</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Le traitement n&apos;a pas pu aboutir. Réessayez ; si le problème persiste, contactez
          l&apos;administrateur.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground/70">Réf. : {error.digest}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={reset} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Réessayer
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => (window.location.href = "/")}>
            <Home className="h-4 w-4" />
            Accueil
          </Button>
        </div>
      </div>
    </div>
  );
}
