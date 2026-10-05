"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet est chargé dynamiquement (refs non typées), comme dans les composants hôtes */
import { useEffect, useRef, type RefObject } from "react";
import { SELECT_COLOR, SELECT_CURSOR, selectOpFromEvent, type BBox, type SelectOp } from "@/lib/map-selection";

const STYLE_ID = "geoaino-selecting-style";
/** En deçà de ce déplacement (px), un appui-relâché est un clic, pas un rectangle. */
const CLICK_TOLERANCE = 4;

/** Zone désignée : un point (clic) ou une emprise (rectangle). */
export type SelectHit = { kind: "point"; lngLat: [number, number] } | { kind: "box"; bbox: BBox };

function ensureSelectingStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Même piège que l'outil de mesure (leaflet-measure.ts) : `pointer-events`
  // est posé explicitement sur chaque `.leaflet-interactive` et, en rendu
  // canevas, c'est le <canvas> qui capte le clic.
  style.textContent =
    ".geoaino-selecting .leaflet-interactive, .geoaino-selecting .leaflet-marker-icon, .geoaino-selecting .leaflet-overlay-pane canvas { pointer-events: none !important; }";
  document.head.appendChild(style);
}

/**
 * Outil « Sélectionner » pour une carte Leaflet impérative (pendant de
 * `useLeafletMeasure`). Actif : curseur de sélection, le glisser trace un
 * rectangle (déplacement de carte, zoom-rectangle et double-clic coupés ;
 * la molette zoome toujours), les objets de la carte ne captent plus les
 * clics (aucune fenêtre ne s'ouvre). L'hôte reçoit la zone désignée et
 * l'opération (Maj ajoute, Ctrl retire), et calcule lui-même les entités
 * touchées sur ses géométries (`lib/map-selection.ts`).
 */
export function useLeafletSelect({
  mapRef,
  active,
  onSelect,
}: {
  mapRef: RefObject<any>;
  active: boolean;
  onSelect: (hit: SelectHit, op: SelectOp) => void;
}): void {
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    if (!active || !map) return;
    const container: HTMLElement = map.getContainer();
    const prevCursor = container.style.cursor;
    const dragWasOn = map.dragging?.enabled?.() ?? false;
    const boxWasOn = map.boxZoom?.enabled?.() ?? false;
    const dblWasOn = map.doubleClickZoom?.enabled?.() ?? false;

    ensureSelectingStyle();
    map.closePopup?.();
    container.classList.add("geoaino-selecting");
    container.style.cursor = SELECT_CURSOR;
    map.dragging?.disable?.();
    map.boxZoom?.disable?.();
    map.doubleClickZoom?.disable?.();

    // Rectangle en cours de tracé (élément DOM, coordonnées conteneur).
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, {
      position: "absolute",
      zIndex: "800",
      pointerEvents: "none",
      display: "none",
      border: `1.5px dashed ${SELECT_COLOR}`,
      background: `${SELECT_COLOR}1f`,
    });
    container.appendChild(box);

    let cleanupDrag: (() => void) | null = null;
    const onDown = (e: { originalEvent: MouseEvent; containerPoint: { x: number; y: number } }) => {
      if (e.originalEvent.button !== 0) return;
      const op = selectOpFromEvent(e.originalEvent);
      const start = { x: e.containerPoint.x, y: e.containerPoint.y };
      const toLocal = (ev: MouseEvent) => {
        const p = map.mouseEventToContainerPoint(ev);
        return { x: p.x, y: p.y };
      };
      const onMove = (ev: MouseEvent) => {
        const p = toLocal(ev);
        Object.assign(box.style, {
          display: "block",
          left: `${Math.min(start.x, p.x)}px`,
          top: `${Math.min(start.y, p.y)}px`,
          width: `${Math.abs(p.x - start.x)}px`,
          height: `${Math.abs(p.y - start.y)}px`,
        });
      };
      const onUp = (ev: MouseEvent) => {
        cleanupDrag?.();
        const end = toLocal(ev);
        if (Math.abs(end.x - start.x) < CLICK_TOLERANCE && Math.abs(end.y - start.y) < CLICK_TOLERANCE) {
          const ll = map.containerPointToLatLng([start.x, start.y]);
          onSelectRef.current({ kind: "point", lngLat: [ll.lng, ll.lat] }, op);
          return;
        }
        const a = map.containerPointToLatLng([start.x, start.y]);
        const b = map.containerPointToLatLng([end.x, end.y]);
        onSelectRef.current(
          {
            kind: "box",
            bbox: [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)],
          },
          op,
        );
      };
      cleanupDrag = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        box.style.display = "none";
        cleanupDrag = null;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    map.on("mousedown", onDown);

    return () => {
      map.off("mousedown", onDown);
      cleanupDrag?.();
      box.remove();
      container.classList.remove("geoaino-selecting");
      container.style.cursor = prevCursor;
      if (dragWasOn) map.dragging?.enable?.();
      if (boxWasOn) map.boxZoom?.enable?.();
      if (dblWasOn) map.doubleClickZoom?.enable?.();
    };
  }, [active, mapRef]);
}
