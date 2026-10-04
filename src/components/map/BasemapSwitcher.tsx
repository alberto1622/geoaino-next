"use client";
import { Layers } from "lucide-react";
import { BASEMAPS, setBasemapId, useBasemapId, useLocalBasemapAvailable } from "@/lib/basemap";

/**
 * Sélecteur de fond de carte (clair / sombre / OSM), commun à toutes les
 * cartes : le choix est partagé et mémorisé (cf. lib/basemap.ts). Masqué si
 * le fond local n'est pas installé — seul OSM serait alors disponible.
 */
export function BasemapSwitcher({ className = "" }: { className?: string }) {
  const current = useBasemapId();
  const available = useLocalBasemapAvailable();
  if (!available) return null;

  return (
    <div
      role="group"
      aria-label="Fond de carte"
      className={`absolute z-[1000] flex items-center gap-0.5 rounded-md border border-border/60 bg-card/90 p-0.5 text-[11px] shadow-sm backdrop-blur-sm ${className}`}
    >
      <Layers className="mx-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {BASEMAPS.map((b) => (
        <button
          key={b.id}
          type="button"
          title={b.title}
          aria-pressed={current === b.id}
          onClick={() => setBasemapId(b.id)}
          className={`rounded px-2 py-0.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            current === b.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
