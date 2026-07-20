"use client";
import { PageTitle } from "@/components/PageTitle";

import dynamic from "next/dynamic";
import { MapPinned } from "lucide-react";

const CadastreMap = dynamic(() => import("@/components/cadastre/CadastreMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[600px] items-center justify-center rounded-xl border border-border/60 text-sm text-muted-foreground">
      Chargement de la carte…
    </div>
  ),
});

export default function CartePage() {
  return (
    <div className="space-y-6">
      <PageTitle title="Carte cadastrale" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MapPinned className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Carte interactive</h1>
          <p className="text-sm text-muted-foreground">
            Parcelles cadastrales par commune — identification au clic, NICAD décomposé.
          </p>
        </div>
      </div>
      <CadastreMap />
    </div>
  );
}
