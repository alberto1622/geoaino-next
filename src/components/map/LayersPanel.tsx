"use client";
import { X } from "lucide-react";
import { BASEMAPS, setBasemapId, useBasemapId, useLocalBasemapAvailable } from "@/lib/basemap";

/**
 * Panneau « Couches » à la manière du panneau Couches de QGIS : groupes de
 * couches avec case à cocher, pastille de couleur et, si fournie, réglage
 * d'opacité ; fond de carte en dernier (tout en bas de l'empilement).
 * L'ordre des groupes suit l'ordre d'affichage : le premier est dessiné au-dessus.
 */

export interface LayerItem {
  id: string;
  label: string;
  color?: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  /** Opacité 0–1 ; le curseur n'apparaît que si `onOpacity` est fourni. */
  opacity?: number;
  onOpacity?: (opacity: number) => void;
}

export interface LayerGroup {
  title: string;
  items: LayerItem[];
}

export function LayersPanel({ groups, onClose, className = "" }: { groups: LayerGroup[]; onClose: () => void; className?: string }) {
  const basemap = useBasemapId();
  const localAvailable = useLocalBasemapAvailable();

  return (
    <div
      role="dialog"
      aria-label="Couches"
      className={`absolute z-20 w-72 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card/95 text-xs shadow-xl backdrop-blur-sm ${className}`}
    >
      <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card/95 px-3 py-2">
        <span className="font-semibold">Couches</span>
        <button type="button" onClick={onClose} aria-label="Fermer le panneau des couches" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {groups.map((g) => (
        <fieldset key={g.title} className="border-b border-border/60 px-3 py-2">
          <legend className="sr-only">{g.title}</legend>
          <div aria-hidden="true" className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</div>
          {g.items.map((it) => (
            <div key={it.id} className="py-1">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={it.checked} onChange={(e) => it.onToggle(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
                {it.color && <span className="h-3 w-3 shrink-0 rounded-sm border border-black/10" style={{ background: it.color }} aria-hidden="true" />}
                <span className={it.checked ? "" : "text-muted-foreground"}>{it.label}</span>
              </label>
              {it.onOpacity && (
                <label className="ml-[1.375rem] mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  Opacité
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={it.opacity ?? 1}
                    disabled={!it.checked}
                    onChange={(e) => it.onOpacity?.(Number(e.target.value))}
                    className="h-1 flex-1 accent-primary disabled:opacity-40"
                    aria-label={`Opacité : ${it.label}`}
                  />
                  <span className="w-8 text-right font-mono">{Math.round((it.opacity ?? 1) * 100)} %</span>
                </label>
              )}
            </div>
          ))}
        </fieldset>
      ))}

      {localAvailable && (
        <fieldset className="px-3 py-2">
          <legend className="sr-only">Fond de carte</legend>
          <div aria-hidden="true" className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fond de carte</div>
          {BASEMAPS.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-2 py-1" title={b.title}>
              <input type="radio" name="fond-de-carte" checked={basemap === b.id} onChange={() => setBasemapId(b.id)} className="h-3.5 w-3.5 accent-primary" />
              <span>{b.title}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
