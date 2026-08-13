"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState, useCallback } from "react";
import { Layers } from "lucide-react";

const ERROR_COLORS: Record<string, string> = {
  OVERLAP: "#ef4444",
  GAP: "#f59e0b",
  SLIVER: "#a855f7",
  DUPLICATE: "#3b82f6",
  INVALID_GEOM: "#ec4899",
  BOUNDARY_CROSS: "#06b6d4",
  MISSING_NICAD: "#6366f1",
  SHORT_NICAD: "#14b8a6",
  SELF_INTERSECT: "#f97316",
  SECTION_MISMATCH: "#84cc16",
};

const ADMIN_LAYERS = [
  { key: "1", label: "Régions", color: "#2563eb", weight: 2 },
  { key: "2", label: "Départements", color: "#16a34a", weight: 1.5 },
  { key: "3", label: "Communes", color: "#9333ea", weight: 1 },
] as const;

type AdminKey = "1" | "2" | "3";

interface GeoError {
  id: number;
  errorType: string;
  severity: string;
  nicad1?: string | null;
  nicad2?: string | null;
  description?: string | null;
  geometry?: unknown;
  area?: number | null;
  corrected?: boolean;
}

interface Props {
  geoJson: string | null;
  errors: GeoError[];
  selectedErrorId?: number | null;
  onFeatureClick?: (props: Record<string, unknown>) => void;
}

function extractNicad(props: Record<string, unknown>): string {
  return String(props.NICAD ?? props.nicad ?? props.NIC ?? "");
}

export default function LeafletMap({ geoJson, errors, selectedErrorId, onFeatureClick }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminLayerRefs = useRef<Record<AdminKey, any>>({ "1": null, "2": null, "3": null });
  const adminCacheRef = useRef<Record<AdminKey, unknown>>({ "1": null, "2": null, "3": null });

  // Base parcel layer (neutral, interactive — handles clicks)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parcelLayerRef = useRef<any>(null);
  // NICAD → raw GeoJSON feature object (to build overlays & blink overlay)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const featureFcRef = useRef<Map<string, any>>(new Map());
  // One colored overlay per error type (non-interactive)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorTypeOverlaysRef = useRef<Map<string, any>>(new Map());
  // Blinking overlay for selected error's parcel(s) (topmost, non-interactive)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blinkOverlayRef = useRef<any>(null);
  const blinkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Error geometry layers (topology errors, unchanged)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorLayersRef = useRef<Map<number, any>>(new Map());

  // Callback refs — always current, never in effect deps
  const onFeatureClickRef = useRef(onFeatureClick);
  const errorsRef = useRef(errors);
  useEffect(() => { onFeatureClickRef.current = onFeatureClick; });
  useEffect(() => { errorsRef.current = errors; });

  const [activeAdmin, setActiveAdmin] = useState<Set<AdminKey>>(new Set());
  const [adminLoading, setAdminLoading] = useState<Set<AdminKey>>(new Set());
  const [showLayerPanel, setShowLayerPanel] = useState(false);

  // ── Init map + custom panes for fixed Z-ordering ────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !mapRef.current) return;
    if (mapInstanceRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");
    delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
      iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
      shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
    });

    const map = L.map(mapRef.current, { center: [14.6928, -17.4467], zoom: 10, zoomControl: true });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap", maxZoom: 20,
    }).addTo(map);

    // Custom panes ensure correct Z-order regardless of add sequence
    map.createPane("parcelPane").style.zIndex = "340";        // neutral base parcels
    map.createPane("errorTypePane").style.zIndex = "350";     // per-type color overlays
    map.createPane("errorGeomPane").style.zIndex = "360";     // topology error geometries
    map.createPane("blinkPane").style.zIndex = "370";         // blinking selection (topmost)
    // Disable pointer events on non-interactive panes
    (map.getPane("errorTypePane") as HTMLElement).style.pointerEvents = "none";
    (map.getPane("errorGeomPane") as HTMLElement).style.pointerEvents = "none";
    (map.getPane("blinkPane") as HTMLElement).style.pointerEvents = "none";

    mapInstanceRef.current = map;
    return () => { map.remove(); mapInstanceRef.current = null; };
  }, []);

  // ── Toggle admin boundary layer ─────────────────────────────────────────────
  const toggleAdminLayer = useCallback(async (key: AdminKey) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");
    const next = new Set(activeAdmin);
    if (next.has(key)) {
      if (adminLayerRefs.current[key]) { map.removeLayer(adminLayerRefs.current[key]); adminLayerRefs.current[key] = null; }
      next.delete(key); setActiveAdmin(new Set(next)); return;
    }
    next.add(key); setActiveAdmin(new Set(next));
    if (!adminCacheRef.current[key]) {
      setAdminLoading((prev) => new Set([...prev, key]));
      try {
        const res = await fetch(`/api/admin-boundaries/${key}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        adminCacheRef.current[key] = await res.json();
      } catch (err) {
        console.error(`[AdminLayer] Niveau ${key}:`, err);
        next.delete(key); setActiveAdmin(new Set(next));
        setAdminLoading((prev) => { const s = new Set(prev); s.delete(key); return s; }); return;
      } finally {
        setAdminLoading((prev) => { const s = new Set(prev); s.delete(key); return s; });
      }
    }
    const cfg = ADMIN_LAYERS.find((l) => l.key === key)!;
    const layer = L.geoJSON(adminCacheRef.current[key], {
      style: () => ({ color: cfg.color, weight: cfg.weight, fillOpacity: 0.04, fillColor: cfg.color }),
      onEachFeature: (feature: { properties?: Record<string, unknown> }, lyr: { bindTooltip: (s: string) => void; bindPopup: (s: string) => void }) => {
        const props = feature.properties || {};
        const nameField = key === "1" ? "NAME_1" : key === "2" ? "NAME_2" : "NAME_3";
        const name = String(props[nameField] || props.name || "");
        const region = String(props.NAME_1 || "");
        const dept = key === "3" ? String(props.NAME_2 || "") : "";
        if (!name) return;
        lyr.bindTooltip(name);
        const lines = [
          `<b>${cfg.label.slice(0, -1)} :</b> ${name}`,
          region && key !== "1" ? `<b>Région :</b> ${region}` : "",
          dept ? `<b>Département :</b> ${dept}` : "",
        ].filter(Boolean).join("<br/>");
        lyr.bindPopup(`<div style="font-family:sans-serif;font-size:12px">${lines}</div>`);
      },
    }).addTo(map);
    adminLayerRefs.current[key] = layer;
  }, [activeAdmin]);

  // ── Load GeoJSON parcels — only on geoJson change ───────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current || !geoJson) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");
    const map = mapInstanceRef.current;

    if (parcelLayerRef.current) { map.removeLayer(parcelLayerRef.current); parcelLayerRef.current = null; }
    featureFcRef.current.clear();

    try {
      const data = JSON.parse(geoJson) as { features?: unknown[] };

      // Cache each feature by NICAD for overlay & blink layer construction
      for (const feature of data.features ?? []) {
        const f = feature as { properties?: Record<string, unknown> };
        const nicad = extractNicad(f.properties ?? {});
        if (nicad) featureFcRef.current.set(nicad, feature);
      }

      const layer = L.geoJSON(data, {
        pane: "parcelPane",
        style: () => ({ color: "#6b7280", weight: 1, fillOpacity: 0.08, fillColor: "#6b7280" }),
        onEachFeature: (
          feature: { properties?: Record<string, unknown> },
          lyr: { bindPopup: (s: string, opts?: object) => void; on: (e: string, cb: () => void) => void }
        ) => {
          const props = feature.properties ?? {};
          const nicad = extractNicad(props) || "N/A";
          lyr.bindPopup(
            `<div style="font-family:monospace;font-size:12px"><b>NICAD:</b> ${nicad}<br/>${Object.entries(props).slice(0, 5).map(([k, v]) => `<b>${k}:</b> ${v}`).join("<br/>")}</div>`,
            { autoPan: false }
          );
          lyr.on("click", () => { onFeatureClickRef.current?.(props); });
        },
      }).addTo(map);

      parcelLayerRef.current = layer;
      map.fitBounds(layer.getBounds(), { padding: [20, 20], animate: false });
    } catch (err) {
      console.error("[LeafletMap] GeoJSON parse error:", err);
    }
  }, [geoJson]);

  // ── Build one colored overlay per error type ────────────────────────────────
  // Non-interactive (pointer-events: none via pane) so clicks pass to parcelPane
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");
    const currentOverlays = errorTypeOverlaysRef.current;

    // Remove all previous overlays
    for (const [, lyr] of currentOverlays) { try { map.removeLayer(lyr); } catch { /* ignore */ } }
    currentOverlays.clear();

    if (featureFcRef.current.size === 0) return;

    // Collect unique NiCADs per error type
    const byType = new Map<string, Set<string>>();
    for (const err of errors) {
      for (const nicad of [err.nicad1, err.nicad2]) {
        if (!nicad || !featureFcRef.current.has(nicad)) continue;
        if (!byType.has(err.errorType)) byType.set(err.errorType, new Set());
        byType.get(err.errorType)!.add(nicad);
      }
    }

    // One L.geoJSON layer per error type
    for (const [errorType, nicads] of byType) {
      const color = ERROR_COLORS[errorType] || "#6b7280";
      const features = Array.from(nicads).map((n) => featureFcRef.current.get(n)).filter(Boolean);
      if (features.length === 0) continue;
      try {
        const lyr = L.geoJSON(
          { type: "FeatureCollection", features },
          {
            pane: "errorTypePane",
            style: () => ({ color, weight: 1.5, fillOpacity: 0.38, fillColor: color }),
          }
        ).addTo(map);
        currentOverlays.set(errorType, lyr);
      } catch { /* ignore */ }
    }
  }, [errors]);

  // ── Blink selected parcel(s) — separate overlay on top (blinkPane) ──────────
  useEffect(() => {
    const map = mapInstanceRef.current;

    // Tear down previous blink
    if (blinkIntervalRef.current) { clearInterval(blinkIntervalRef.current); blinkIntervalRef.current = null; }
    if (blinkOverlayRef.current && map) {
      try { map.removeLayer(blinkOverlayRef.current); } catch { /* ignore */ }
      blinkOverlayRef.current = null;
    }

    if (selectedErrorId == null || !map) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");

    const selErr = errors.find((e) => e.id === selectedErrorId);
    if (!selErr) return;

    const nicads = [selErr.nicad1, selErr.nicad2].filter((n): n is string => Boolean(n));
    const features = nicads.map((n) => featureFcRef.current.get(n)).filter(Boolean);
    if (features.length === 0) return;

    const color = ERROR_COLORS[selErr.errorType] || "#ef4444";
    try {
      const blinkLayer = L.geoJSON(
        { type: "FeatureCollection", features },
        {
          pane: "blinkPane",
          style: () => ({ color, weight: 3, fillOpacity: 0.7, fillColor: color }),
        }
      ).addTo(map);
      blinkOverlayRef.current = blinkLayer;

      let bright = true;
      blinkIntervalRef.current = setInterval(() => {
        try {
          blinkLayer.setStyle({ color, weight: bright ? 3 : 1.5, fillOpacity: bright ? 0.7 : 0.05, fillColor: color });
        } catch { /* ignore */ }
        bright = !bright;
      }, 420);
    } catch { /* ignore */ }

    return () => {
      if (blinkIntervalRef.current) { clearInterval(blinkIntervalRef.current); blinkIntervalRef.current = null; }
      if (blinkOverlayRef.current && map) {
        try { map.removeLayer(blinkOverlayRef.current); } catch { /* ignore */ }
        blinkOverlayRef.current = null;
      }
    };
  }, [selectedErrorId, errors]);

  // ── Sync error geometry layers (topology errors) ────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet");
    const currentLayers = errorLayersRef.current;

    const newIds = new Set(errors.filter((e) => e.geometry).map((e) => e.id));
    for (const [id, lyr] of currentLayers) {
      if (!newIds.has(id)) { try { map.removeLayer(lyr); } catch { /* ignore */ } currentLayers.delete(id); }
    }

    for (const err of errors) {
      if (!err.geometry) continue;
      const color = ERROR_COLORS[err.errorType] || "#6b7280";
      const isSelected = selectedErrorId === err.id;
      const style = {
        color,
        weight: isSelected ? 3 : 1.5,
        fillOpacity: isSelected ? 0.5 : 0.22,
        fillColor: color,
        dashArray: err.corrected ? "5,5" : undefined,
      };
      if (currentLayers.has(err.id)) {
        try { currentLayers.get(err.id).setStyle(style); } catch { /* ignore */ }
        continue;
      }
      try {
        const lyr = L.geoJSON(
          { type: "Feature", geometry: err.geometry, properties: {} },
          { pane: "errorGeomPane", style: () => style }
        );
        lyr.bindPopup(
          `<div style="font-family:monospace;font-size:11px;max-width:220px"><b style="color:${color}">${err.errorType}</b> [${err.severity}]<br/>NICAD: ${err.nicad1 || "?"}<br/>${err.description?.slice(0, 100) || ""}${err.area ? `<br/>Surface: ${err.area.toFixed(2)} m²` : ""}</div>`,
          { autoPan: false }
        );
        lyr.addTo(map);
        currentLayers.set(err.id, lyr);
      } catch { /* ignore */ }
    }

    // Smooth fly to selected error
    if (selectedErrorId != null && currentLayers.has(selectedErrorId)) {
      try {
        const bounds = currentLayers.get(selectedErrorId).getBounds();
        if (bounds.isValid()) {
          map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 18, duration: 0.4 });
          currentLayers.get(selectedErrorId).openPopup();
        }
      } catch { /* ignore */ }
    }
  }, [errors, selectedErrorId]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full" style={{ minHeight: "400px" }}>
      <div ref={mapRef} className="w-full h-full" />

      <div className="absolute top-3 right-3 z-[1000]">
        <div className="relative">
          <button
            onClick={() => setShowLayerPanel((v) => !v)}
            className={`cursor-pointer flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-md transition-all ${
              showLayerPanel || activeAdmin.size > 0
                ? "bg-primary text-primary-foreground"
                : "bg-card border border-border text-foreground hover:border-primary/40"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Limites admin
            {activeAdmin.size > 0 && (
              <span className="ml-1 bg-white/20 rounded-full w-4 h-4 flex items-center justify-center text-[10px]">
                {activeAdmin.size}
              </span>
            )}
          </button>

          {showLayerPanel && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-card border border-border rounded-lg shadow-xl p-2 space-y-1">
              {ADMIN_LAYERS.map(({ key, label, color }) => {
                const isActive = activeAdmin.has(key);
                const isLoading = adminLoading.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleAdminLayer(key)}
                    disabled={isLoading}
                    className={`cursor-pointer w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-all ${
                      isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-sm border-2 shrink-0"
                      style={{ borderColor: color, background: isActive ? color + "22" : "transparent" }}
                    />
                    <span className="flex-1 text-left">{label}</span>
                    {isLoading && <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin shrink-0" />}
                  </button>
                );
              })}
              <p className="text-[10px] text-muted-foreground px-1 pt-1 border-t border-border">Source : GADM 4.1</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
