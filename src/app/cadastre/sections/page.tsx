"use client";

import dynamic from "next/dynamic";

const SectionsClient = dynamic(
  () => import("@/components/cadastre/SectionsClient"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[600px] items-center justify-center rounded-xl border border-border/60 text-sm text-muted-foreground">
        Chargement…
      </div>
    ),
  },
);

export default function SectionsPage() {
  return (
    <div className="space-y-4">
      {/* <div>
        <h1 className="text-xl font-bold tracking-tight">Limites de section (DXF)</h1>
        <p className="text-sm text-muted-foreground">
          Construire la table <code className="font-mono">limite_section</code> depuis un DXF
          (couche <code className="font-mono">limites_sections</code> + <code className="font-mono">numero_section</code>),
          contrôler les chevauchements et appliquer les corrections.
        </p>
      </div> */}
      <SectionsClient />
    </div>
  );
}
