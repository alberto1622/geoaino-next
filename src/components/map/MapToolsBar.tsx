"use client";
import type { ReactNode } from "react";
import { Layers, Ruler, Pentagon, SquareDashedMousePointer } from "lucide-react";
import type { MeasureMode } from "@/lib/use-measure";

/**
 * Barre d'outils de carte : « Couches » (si `onToggleLayers` est fourni),
 * « Sélectionner » (si `onSelectMode` est fourni) et outils de mesure.
 * `children` s'insère en tête (ex. annuler/rétablir).
 * Ouvrir les couches quitte la mesure et inversement : leurs encarts
 * occupent le même coin. Sélection et mesure s'excluent : un clic carte ne
 * peut servir qu'à un outil à la fois.
 */
export function MapToolsBar({
  layersOpen = false,
  onToggleLayers,
  measureMode,
  onMeasureMode,
  selectMode = false,
  onSelectMode,
  className = "",
  children,
}: {
  layersOpen?: boolean;
  onToggleLayers?: (open: boolean) => void;
  measureMode: MeasureMode;
  onMeasureMode: (m: MeasureMode) => void;
  selectMode?: boolean;
  onSelectMode?: (on: boolean) => void;
  className?: string;
  children?: ReactNode;
}) {
  const btn = (active: boolean) =>
    `flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-colors cursor-pointer ${
      active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
    }`;
  return (
    <div className={`absolute z-[1000] flex items-center gap-1 rounded-lg border border-border bg-card/90 px-1.5 py-1 shadow-lg backdrop-blur-sm ${className}`}>
      {children}
      {children && <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />}
      {onToggleLayers && (
        <button
          type="button"
          onClick={() => {
            onToggleLayers(!layersOpen);
            onMeasureMode(null);
          }}
          aria-pressed={layersOpen}
          title="Couches"
          className={btn(layersOpen)}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Couches</span>
        </button>
      )}
      {onSelectMode && (
        <button
          type="button"
          onClick={() => {
            onSelectMode(!selectMode);
            onMeasureMode(null);
          }}
          aria-pressed={selectMode}
          title={"Sélectionner des entités : clic ou rectangle\nMaj : ajouter · Ctrl : retirer · Suppr : supprimer · Échap : désélectionner / quitter"}
          aria-label="Sélectionner des entités"
          className={btn(selectMode)}
        >
          <SquareDashedMousePointer className="w-3.5 h-3.5" />
        </button>
      )}
      {([
        ["distance", Ruler, "Mesurer une distance"],
        ["surface", Pentagon, "Mesurer une surface"],
      ] as const).map(([mode, Icon, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => {
            onMeasureMode(measureMode === mode ? null : mode);
            onToggleLayers?.(false);
            onSelectMode?.(false);
          }}
          aria-pressed={measureMode === mode}
          title={`${label} (Échap pour quitter)`}
          aria-label={label}
          className={btn(measureMode === mode)}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  );
}
