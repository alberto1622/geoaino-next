"use client";
import { lengthMeters, areaSquareMeters, formatLength, formatArea, type LngLat } from "@/lib/measure";
import type { MeasureMode } from "@/lib/use-measure";

/** Encart du résultat de l'outil « Mesurer » (distance, ou surface + périmètre). */
export function MeasurePanel({
  mode,
  pts,
  onUndo,
  onClear,
  className = "",
}: {
  mode: MeasureMode;
  pts: LngLat[];
  onUndo: () => void;
  onClear: () => void;
  className?: string;
}) {
  if (!mode) return null;
  const value =
    mode === "distance"
      ? pts.length >= 2 ? formatLength(lengthMeters(pts)) : null
      : pts.length >= 3 ? formatArea(areaSquareMeters(pts)) : null;
  const perimeter = mode === "surface" && pts.length >= 3 ? formatLength(lengthMeters([...pts, pts[0]])) : null;

  return (
    <div
      className={`absolute z-[1000] w-64 rounded-lg border border-border bg-card/95 p-2.5 text-xs shadow-lg backdrop-blur-sm ${className}`}
      role="status"
      aria-live="polite"
    >
      <div className="font-semibold">{mode === "distance" ? "Mesure de distance" : "Mesure de surface"}</div>
      {value ? (
        <>
          <div className="mt-1 font-mono text-sm text-primary">{value}</div>
          {perimeter && <div className="font-mono text-muted-foreground">Périmètre : {perimeter}</div>}
        </>
      ) : (
        <div className="mt-1 text-muted-foreground">
          Cliquez sur la carte pour placer {mode === "distance" ? "au moins 2 points" : "au moins 3 sommets"}.
        </div>
      )}
      {pts.length > 0 && (
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={onUndo} className="rounded border border-border px-2 py-0.5 hover:bg-muted">
            Retirer le dernier point
          </button>
          <button type="button" onClick={onClear} className="rounded border border-border px-2 py-0.5 hover:bg-muted">
            Effacer
          </button>
        </div>
      )}
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        Mesure géodésique (WGS84) · {pts.length} point(s) · Échap pour quitter
      </div>
    </div>
  );
}
