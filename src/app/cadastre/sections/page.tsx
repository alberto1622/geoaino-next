"use client";
import { PageTitle } from "@/components/PageTitle";

import dynamic from "next/dynamic";

const SectionsClient = dynamic(
  () => import("@/components/cadastre/SectionsClient"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-150 items-center justify-center rounded-xl border border-border/60 text-sm text-muted-foreground">
        Chargement…
      </div>
    ),
  },
);

export default function SectionsPage() {
  return (
    // Hauteur bornée à l'écran (NavBar 4rem + padding py-2 du main 1rem) : la
    // carte absorbe l'espace restant, la page ne défile plus sur grand écran.
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-5rem)]">
      <PageTitle title="Limites de section" />
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
