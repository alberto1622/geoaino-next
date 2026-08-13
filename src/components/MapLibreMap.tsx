"use client";
import RMap, {
  Source, Layer, NavigationControl, ScaleControl, Popup, Marker,
} from "react-map-gl/maplibre";
import type { MapRef, MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { StyleSpecification } from "maplibre-gl";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { errorTypeColor } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INITIAL_VIEW = { longitude: -14.5, latitude: 14.5, zoom: 7 };

// Self-contained raster style — no external style.json needed
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      // OSM ne sert des tuiles que jusqu'au zoom 19. Au-delà (parcelles/slivers
      // minuscules), MapLibre agrandit les tuiles z19 au lieu de demander des
      // tuiles z20+ inexistantes (qui provoquaient des erreurs "Failed to fetch").
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

// Valeurs de NICAD considérées « manquantes » (alignées sur geo-engine).
const MISSING_NICAD_VALUES = [
  "", "null", "undefined", "na", "n/a", "néant", "neant", "aucun", "sans nicad", "0", "-",
];

// Types d'erreur dont la géométrie EST une parcelle déjà colorée par les tuiles
// vecteur (`_nicad` pour les doublons, `_nstat` pour les NICAD manquants/courts).
// Exclus de l'overlay `error-geoms` pour éviter de superposer une seconde copie de
// la parcelle. Les autres types (OVERLAP/GAP/SLIVER/INVALID_GEOM) sont des
// géométries « région/résidu » sans équivalent sur les tuiles → gardées en overlay.
const TILE_COLORED_ERROR_TYPES = new Set(["DUPLICATE", "MISSING_NICAD", "SHORT_NICAD"]);

interface GeoError {
  id: number;
  errorType: string;
  severity: string;
  nicad1?: string | null;
  nicad2?: string | null;
  description?: string | null;
  geometry?: unknown;
  area?: number | null;
  confidence: number;
  corrected: boolean;
}

interface Props {
  /** Analyse dont les parcelles sont servies en tuiles vectorielles (MVT). */
  analysisId: number;
  /** Version (updatedAt/hash corrections) : invalide le cache des tuiles côté client. */
  tilesVersion?: string | number | null;
  /** Emprise globale [w,s,e,n] (EPSG:4326) pour le fit initial (via map-meta). */
  initialBounds?: [number, number, number, number] | null;
  errors: GeoError[];
  selectedErrorId?: number;
  /** Clignotement renforcé (plus rapide/opaque/épais) — parcelles à NICAD dupliqué. */
  blinkIntense?: boolean;
  onFeatureClick?: (props: Record<string, unknown>, point?: { lng: number; lat: number }) => void;
  selectedNicads?: string[];
  searchedNicads?: string[];
  focusTarget?: { nicad: string; key: number } | null;
  conformeHighlight?: boolean;
  nonConformeNicads?: string[];
  /** Occurrences d'un NICAD dupliqué à annoter sur la carte (centroïdes numérotés). */
  occurrences?: { lng: number; lat: number; label: string }[];
  /** Emprise englobant toutes les occurrences → fit au clic sur une doublure. */
  occurrencesBounds?: [number, number, number, number] | null;
  /** Mode édition doublons : les marqueurs deviennent cliquables (« conserver celle-ci »). */
  occurrenceEditMode?: boolean;
  /** Clic sur un marqueur d'occurrence en mode édition (index dans `occurrences`). */
  onOccurrenceKeep?: (index: number) => void;
  /** Affiche les limites de sections (table `limite_section`) + numéros de section. */
  showSections?: boolean;
  /** Colore les parcelles SANS section rattachée (`_ssec`, numero_section absent/« 000 »). */
  sansSectionHighlight?: boolean;
  /** NICAD supprimés côté client : masqués immédiatement sans attendre le refetch des tuiles. */
  deletedNicads?: string[];
  /** Niveaux de limites administratives actifs (régions/départements/communes, référentiel national). */
  adminLevels?: AdminLevel[];
}

/** Couleur des parcelles sans section (orange, distinct des types d'erreur). */
const SANS_SECTION_COLOR = "#f97316";

/** Couleur des limites/étiquettes de sections (rouge, distinct des parcelles grises). */
const SECTION_COLOR = "#ef4444";

/** Libellés FR pour la légende — mêmes types que errorTypeColor() (lib/utils.ts).
 * missing_nicad/short_nicad en sont exclus : traités séparément dans `legendItems`
 * car toujours affichés (couches non conditionnelles, cf. commentaire ligne ~550). */
const ERROR_TYPE_LABELS: Record<string, string> = {
  overlap: "Chevauchement",
  gap: "Trou",
  sliver: "Esquille",
  duplicate: "Doublon NICAD",
  invalid_geom: "Géométrie invalide",
  boundary_cross: "Sort des limites administratives",
  self_intersect: "Auto-intersection",
  section_mismatch: "Incohérence de section",
};
/** Zoom minimal d'affichage des étiquettes de numéros de section (marqueurs DOM). */
const SECTION_LABEL_MIN_ZOOM = 10;

interface SectionLabel { lng: number; lat: number; numSection: string | null; commune: string | null }
interface SectionsData { boundaries: GeoJSON.FeatureCollection; labels: SectionLabel[] }

// ── Limites administratives (régions / départements / communes) ──────────────
// Mêmes contours nationaux que /cadastre/sections, servis par
// /api/cadastre/admin-boundaries (dérivés de cad_communes_2026), plutôt que le
// contour déduit de l'emprise de l'analyse (abandonné pour rester cohérent
// avec la page sections).
type AdminLevel = "regions" | "departements" | "communes";
const ADMIN_STYLES: Record<
  AdminLevel,
  { label: string; color: string; width: number; dasharray?: number[]; minLabelZoom: number; fontSize: number }
> = {
  regions: { label: "Régions", color: "#b91c1c", width: 3, minLabelZoom: 5, fontSize: 12 },
  departements: { label: "Départements", color: "#b45309", width: 2, dasharray: [6, 3], minLabelZoom: 7.5, fontSize: 12 },
  communes: { label: "Communes", color: "#0f766e", width: 1.2, dasharray: [4, 3], minLabelZoom: 9, fontSize: 10 },
};
interface AdminLabel { lng: number; lat: number; nom: string }
interface AdminData { boundaries: GeoJSON.FeatureCollection; labels: AdminLabel[] }

interface PopupState { lng: number; lat: number; html: string }

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function computeBbox(features: unknown[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  let found = false;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lng = c[0] as number, lat = c[1] as number;
      if (isFinite(lng) && isFinite(lat)) {
        found = true;
        if (lng < w) w = lng; if (lat < s) s = lat;
        if (lng > e) e = lng; if (lat > n) n = lat;
      }
    } else { for (const i of c) walk(i); }
  };
  for (const feat of features) {
    const f = feat as { geometry?: { coordinates?: unknown } };
    if (f?.geometry?.coordinates) walk(f.geometry.coordinates);
  }
  return found ? [[w, s], [e, n]] : null;
}

export default function MapLibreMap({ analysisId, tilesVersion, initialBounds, errors, selectedErrorId, blinkIntense = false, onFeatureClick, selectedNicads = [], searchedNicads = [], focusTarget, conformeHighlight = false, nonConformeNicads = [], occurrences = [], occurrencesBounds = null, occurrenceEditMode = false, onOccurrenceKeep, showSections = false, sansSectionHighlight = false, deletedNicads = [], adminLevels = [] }: Props) {
  const mapRef = useRef<MapRef>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onClickRef = useRef(onFeatureClick);
  useEffect(() => { onClickRef.current = onFeatureClick; });
  // Cache des emprises par NICAD résolues côté serveur (évite de re-fetcher).
  const boundsCacheRef = useRef<Map<string, [[number, number], [number, number]] | null>>(new Map());

  const [mapReady, setMapReady] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [blinkOpacity, setBlinkOpacity] = useState(0);
  const [blinkColor, setBlinkColor] = useState("#ffffff");
  const [cursor, setCursor] = useState("grab");
  // Limites de sections (chargées une fois, à la première activation).
  const [sectionsData, setSectionsData] = useState<SectionsData | null>(null);
  // Contours administratifs par niveau (chargés une fois par niveau, à sa première activation).
  const [adminData, setAdminData] = useState<Partial<Record<AdminLevel, AdminData>>>({});
  const adminFetchingRef = useRef<Set<AdminLevel>>(new Set());
  // Zoom courant : les étiquettes de sections (marqueurs DOM) ne sont rendues
  // qu'à partir de SECTION_LABEL_MIN_ZOOM pour éviter l'encombrement en vue large.
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);

  // ── Chargement des limites de sections (table limite_section, tous lots) ───
  useEffect(() => {
    if (!showSections || sectionsData) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/cadastre/sections/geojson");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Chargement des sections échoué");
        if (!cancelled) {
          setSectionsData({
            boundaries: data.boundaries ?? { type: "FeatureCollection", features: [] },
            labels: data.labels ?? [],
          });
        }
      } catch (err) {
        console.warn("[MapLibreMap] sections:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [showSections, sectionsData]);

  // ── Chargement des limites administratives (référentiel national, une fois par niveau) ─
  useEffect(() => {
    for (const level of adminLevels) {
      if (adminData[level] || adminFetchingRef.current.has(level)) continue;
      adminFetchingRef.current.add(level);
      void (async () => {
        try {
          const res = await fetch(`/api/cadastre/admin-boundaries?niveau=${level}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Chargement des contours échoué");
          setAdminData((prev) => ({ ...prev, [level]: data as AdminData }));
        } catch (err) {
          console.warn(`[MapLibreMap] admin-boundaries (${level}):`, err);
        }
      })();
    }
  }, [adminLevels, adminData]);

  // ── URL des tuiles vectorielles ───────────────────────────────────────────
  // Composant client-only (ssr:false) → `window` disponible. `tilesVersion`
  // (updatedAt) invalide le cache navigateur après une correction.
  const tilesUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // `sv` = version du SCHÉMA des propriétés de tuiles (incrémenter à chaque
    // ajout de propriété, ex. _ssec) : invalide le cache navigateur même quand
    // `tilesVersion` (updatedAt) n'a pas bougé.
    const v = tilesVersion != null ? `?v=${encodeURIComponent(String(tilesVersion))}&sv=2` : "?sv=2";
    return `${origin}/api/analyses/${analysisId}/tiles/{z}/{x}/{y}${v}`;
  }, [analysisId, tilesVersion]);

  // ── Fit sur un NICAD via l'emprise servie par map-meta ─────────────────────
  // Les géométries ne sont plus embarquées côté client : on résout l'emprise
  // d'une parcelle à la demande (mise en cache) pour le focus/recherche/erreur.
  const fitToNicad = useCallback(async (nicad: string) => {
    const map = mapRef.current;
    if (!map || !nicad) return;
    let bounds = boundsCacheRef.current.get(nicad);
    if (bounds === undefined) {
      try {
        const res = await fetch(`/api/analyses/${analysisId}/map-meta?nicad=${encodeURIComponent(nicad)}`);
        const data = (await res.json()) as { bounds: [number, number, number, number] | null };
        bounds = data.bounds
          ? [[data.bounds[0], data.bounds[1]], [data.bounds[2], data.bounds[3]]]
          : null;
      } catch {
        bounds = null;
      }
      boundsCacheRef.current.set(nicad, bounds);
    }
    if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 600 });
  }, [analysisId]);

  // ── Error geometries GeoJSON ──────────────────────────────────────────────
  // On NE dessine PAS la géométrie propre des erreurs dont la géométrie EST une
  // parcelle déjà rendue (et colorée) par les tuiles vecteur : la redessiner en
  // overlay superposerait une seconde copie (légèrement décalée) de la même
  // parcelle. Ces types sont colorés via les tuiles (`_nicad` / `_nstat`). On ne
  // garde en overlay que les géométries « région/résidu » absentes des tuiles :
  // chevauchement (intersection), espace vide, sliver, géométrie invalide.
  const errorGeomsFc = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: errors
      .filter((e) => e.geometry && !TILE_COLORED_ERROR_TYPES.has((e.errorType ?? "").toUpperCase()))
      .map((e) => ({
        type: "Feature" as const,
        id: e.id,
        geometry: e.geometry as GeoJSON.Geometry,
        properties: {
          _color: errorTypeColor(e.errorType),
          _opacity: e.id === selectedErrorId ? 0.5 : 0.22,
          _selected: e.id === selectedErrorId,
        },
      })),
  }), [errors, selectedErrorId]);

  // ── Blink (surlignage clignotant de la parcelle en erreur) ────────────────
  // Plus de géométrie côté client : on cible la parcelle par son `_nicad` dans
  // la source vecteur via un filtre (opacité animée plus bas).
  const blinkNicad = useMemo(() => {
    if (!selectedErrorId) return null;
    return errors.find((e) => e.id === selectedErrorId)?.nicad1 ?? null;
  }, [errors, selectedErrorId]);

  const blinkFilter = useMemo(
    () =>
      (blinkNicad
        ? ["==", ["get", "_nicad"], blinkNicad]
        : ["in", ["get", "_nicad"], ["literal", []]]) as any,
    [blinkNicad]
  );

  // ── NiCAD lists per error type ────────────────────────────────────────────
  const nicadsByType = useMemo<Record<string, string[]>>(() => {
    const res: Record<string, string[]> = {};
    for (const e of errors) {
      if (!res[e.errorType]) res[e.errorType] = [];
      if (e.nicad1) res[e.errorType].push(e.nicad1);
      if (e.nicad2) res[e.errorType].push(e.nicad2);
    }
    for (const t in res) res[t] = [...new Set(res[t])];
    return res;
  }, [errors]);
  const errorTypes = useMemo(() => Object.keys(nicadsByType), [nicadsByType]);

  // ── Légende dynamique : uniquement les couleurs effectivement à l'écran ──
  // Parcelle/NICAD manquant/NICAD trop court sont toujours affichés (couches
  // non conditionnelles) ; le reste suit exactement les mêmes conditions que
  // les couches correspondantes plus bas dans le rendu.
  const legendItems = useMemo(() => {
    const items: { label: string; color: string }[] = [
      { label: "Parcelle", color: "#6b7280" },
      { label: "NICAD manquant", color: errorTypeColor("missing_nicad") },
      { label: "NICAD trop court", color: errorTypeColor("short_nicad") },
    ];
    if (conformeHighlight) items.push({ label: "Conforme", color: "#22c55e" });
    if (sansSectionHighlight) items.push({ label: "Sans section", color: SANS_SECTION_COLOR });
    if (showSections && sectionsData) items.push({ label: "Limite de section", color: SECTION_COLOR });
    if (selectedNicads.length > 0) items.push({ label: "Sélectionné", color: "#3b82f6" });
    if (searchedNicads.length > 0) items.push({ label: "Recherché", color: "#facc15" });
    for (const type of errorTypes) {
      const key = type.toLowerCase();
      if (key === "missing_nicad" || key === "short_nicad") continue;
      items.push({ label: ERROR_TYPE_LABELS[key] ?? type, color: errorTypeColor(type) });
    }
    return items;
  }, [errorTypes, conformeHighlight, sansSectionHighlight, showSections, sectionsData, selectedNicads, searchedNicads]);

  // Filtre « parcelle conforme » : NICAD d'au moins 8 caractères, non listé comme
  // valeur « vide », et absent des NICAD en erreur. Aligné sur le décompte client.
  const conformeFilter = useMemo(
    () =>
      [
        "all",
        [">=", ["length", ["get", "_nicad"]], 8],
        ["!", ["in", ["downcase", ["get", "_nicad"]], ["literal", MISSING_NICAD_VALUES]]],
        ["!", ["in", ["get", "_nicad"], ["literal", nonConformeNicads]]],
        ["!", ["in", ["get", "_nicad"], ["literal", deletedNicads]]],
      ] as any,
    [nonConformeNicads, deletedNicads]
  );

  // Parcelles supprimées côté client (avant refetch des tuiles) : exclues de toutes
  // les couches issues de la source vecteur pour un retrait immédiat sans « reload ».
  const notDeletedFilter = useMemo(
    () => ["!", ["in", ["get", "_nicad"], ["literal", deletedNicads]]] as any,
    [deletedNicads]
  );

  // ── Blink animation ───────────────────────────────────────────────────────
  useEffect(() => {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    if (!selectedErrorId || !blinkNicad) { setBlinkOpacity(0); return; }
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) { setBlinkOpacity(0); return; }
    setBlinkColor(errorTypeColor(err.errorType));
    // Clignotement renforcé pour les doublons : plus rapide et plus contrasté.
    const period = blinkIntense ? 200 : 420;
    const hi = blinkIntense ? 0.95 : 0.65;
    const lo = blinkIntense ? 0.25 : 0.05;
    let bright = true;
    const tick = () => { bright = !bright; setBlinkOpacity(bright ? hi : lo); };
    tick();
    blinkTimerRef.current = setInterval(tick, period);
    return () => { if (blinkTimerRef.current) clearInterval(blinkTimerRef.current); };
  }, [selectedErrorId, blinkNicad, errors, blinkIntense]);

  // ── Fit bounds initial (emprise globale via map-meta) ─────────────────────
  useEffect(() => {
    if (!mapReady || !initialBounds) return;
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(
      [[initialBounds[0], initialBounds[1]], [initialBounds[2], initialBounds[3]]],
      { padding: 40, maxZoom: 16, duration: 600 }
    );
  }, [mapReady, initialBounds]);

  // ── Fit bounds on selected error ──────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !selectedErrorId) return;
    const map = mapRef.current;
    if (!map) return;
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) return;
    // Doublons : le zoom englobe TOUTES les occurrences (via `occurrencesBounds`),
    // pas la seule géométrie de cette occurrence → géré par l'effet dédié ci-dessous.
    if (err.errorType?.toUpperCase() === "DUPLICATE") return;
    // L'erreur porte sa propre géométrie (gap/sliver/overlap) → fit direct ;
    // sinon on résout l'emprise de la parcelle nicad1 côté serveur.
    if (err.geometry) {
      const bbox = computeBbox([{ geometry: err.geometry }]);
      if (bbox) map.fitBounds(bbox, { padding: 80, maxZoom: 18, duration: 600 });
    } else if (err.nicad1) {
      void fitToNicad(err.nicad1);
    }
  }, [mapReady, errors, selectedErrorId, fitToNicad]);

  // ── Fit bounds on search/focus target ─────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !focusTarget) return;
    void fitToNicad(focusTarget.nicad);
  }, [mapReady, focusTarget, fitToNicad]);

  // ── Fit bounds sur TOUTES les occurrences d'un doublon ────────────────────
  // Au clic sur une doublure, on zoome sur l'emprise englobant chaque occurrence
  // (et non la seule parcelle cliquée) pour les comparer visuellement d'un coup.
  useEffect(() => {
    if (!mapReady || !occurrencesBounds) return;
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(
      [[occurrencesBounds[0], occurrencesBounds[1]], [occurrencesBounds[2], occurrencesBounds[3]]],
      { padding: 120, maxZoom: 18, duration: 700 }
    );
  }, [mapReady, occurrencesBounds]);

  // ── Click handler ─────────────────────────────────────────────────────────
  const handleClick = useCallback((e: MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat?.properties) { setPopup(null); return; }
    const props = feat.properties as Record<string, unknown>;
    // Le point cliqué (WGS84) est garanti intérieur à la parcelle : sert de
    // localisateur fiable pour la suppression depuis la table attributaire.
    onClickRef.current?.(props, { lng: e.lngLat.lng, lat: e.lngLat.lat });
    // Code section : propriété directe si renseignée, sinon dérivé du NICAD
    // (16 caractères = préfixe 8 + section 3 + parcelle 5, cf. nicad.ts).
    const directSection = String(props.numero_section ?? props.num_section ?? props.NUM_SECTION ?? "").trim();
    const nicad = String(props.nicad ?? props.NICAD ?? "").trim();
    const sectionCode =
      directSection && directSection !== "000"
        ? directSection
        : nicad.length === 16
          ? nicad.slice(8, 11)
          : directSection;
    const sectionRow = sectionCode
      ? `<div style="display:flex;gap:6px;padding:1px 0;border-bottom:1px solid #e5e7eb;margin-bottom:2px">` +
        `<span style="color:#6b7280;width:80px;flex-shrink:0;font-size:10px">Code section</span>` +
        `<span style="color:#111827;font-weight:600">${escHtml(sectionCode)}</span></div>`
      : "";
    const rows = Object.entries(props)
      .filter(([k]) => !k.startsWith("_") && k !== "numero_section" && k !== "num_section" && k !== "NUM_SECTION")
      .slice(0, 10)
      .map(([k, v]) =>
        `<div style="display:flex;gap:6px;padding:1px 0">` +
        `<span style="color:#6b7280;width:80px;flex-shrink:0;font-size:10px">${escHtml(k)}</span>` +
        `<span style="color:#111827;word-break:break-all;font-weight:500">${escHtml(String(v ?? ""))}</span></div>`
      ).join("");
    setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, html: sectionRow + rows });
  }, []);

  return (
    <div className="w-full h-full relative">
      <RMap
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        onClick={handleClick}
        interactiveLayerIds={["parcelles-fill"]}
        onMouseEnter={() => setCursor("pointer")}
        onMouseLeave={() => setCursor("grab")}
        cursor={cursor}
        onLoad={() => setMapReady(true)}
        onMoveEnd={(e) => setZoom(e.viewState.zoom)}
        attributionControl={false}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <ScaleControl position="bottom-left" maxWidth={100} unit="metric" />

        {/* ── Parcelles (tuiles vectorielles MVT, couche « parcelles ») ── */}
        <Source id="parcelles" type="vector" tiles={[tilesUrl]} minzoom={0} maxzoom={20}>
          <Layer id="parcelles-fill" source-layer="parcelles" type="fill" paint={{ "fill-color": "#6b7280", "fill-opacity": 0.22 }} filter={notDeletedFilter} />
          <Layer id="parcelles-line" source-layer="parcelles" type="line" paint={{ "line-color": "#9ca3af", "line-width": 0.8, "line-opacity": 0.6 }} filter={notDeletedFilter} />
        </Source>

        {/* ── Limites de sections (table limite_section) — contours rouges ── */}
        {showSections && sectionsData && (
          <Source id="sections-limites" type="geojson" data={sectionsData.boundaries}>
            <Layer
              id="sections-line"
              type="line"
              paint={{ "line-color": SECTION_COLOR, "line-width": 2, "line-opacity": 0.9 }}
            />
          </Source>
        )}

        {/* ── Limites administratives (régions/départements/communes, référentiel national) ── */}
        {adminLevels.map((level) => {
          const data = adminData[level];
          if (!data) return null;
          const st = ADMIN_STYLES[level];
          return (
            <Source key={level} id={`admin-${level}`} type="geojson" data={data.boundaries}>
              <Layer
                id={`admin-${level}-line`}
                type="line"
                paint={{
                  "line-color": st.color,
                  "line-width": st.width,
                  "line-opacity": 0.85,
                  ...(st.dasharray ? { "line-dasharray": st.dasharray } : {}),
                }}
              />
            </Source>
          );
        })}

        {/* ── Error geometry overlays ── */}
        <Source id="error-geoms" type="geojson" data={errorGeomsFc}>
          <Layer
            id="error-geoms-fill"
            type="fill"
            paint={{
              "fill-color": ["coalesce", ["get", "_color"], "#ef4444"] as any,
              "fill-opacity": ["coalesce", ["get", "_opacity"], 0.22] as any,
            }}
          />
          <Layer
            id="error-geoms-line"
            type="line"
            paint={{
              "line-color": ["coalesce", ["get", "_color"], "#ef4444"] as any,
              "line-width": ["case", ["coalesce", ["get", "_selected"], false], 2.5, 1.2] as any,
              "line-opacity": 0.9,
            }}
          />
        </Source>

        {/* ── Blink (filtre sur _nicad dans la source vecteur) ── */}
        <Layer
          id="blink-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          filter={blinkFilter}
          paint={{ "fill-color": blinkColor, "fill-opacity": blinkOpacity }}
        />
        <Layer
          id="blink-line"
          source="parcelles"
          source-layer="parcelles"
          type="line"
          filter={blinkFilter}
          paint={{ "line-color": blinkColor, "line-width": blinkIntense ? 6 : 3, "line-opacity": blinkOpacity }}
        />

        {/* ── Anchor: error type layers insert before this, selection highlight inserts after ── */}
        <Layer
          id="error-type-top"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#000", "fill-opacity": 0 }}
        />

        {/* ── Parcelles conformes (vert) — surlignage optionnel ──
            Conforme = NICAD valide (≥ 8 car., pas une valeur « vide ») ET absent de
            la liste des NICAD en erreur. Même définition que le décompte « conformes ». ── */}
        {conformeHighlight && (
          <>
            <Layer
              id="conforme-fill"
              source="parcelles"
              source-layer="parcelles"
              type="fill"
              beforeId="error-type-top"
              paint={{ "fill-color": "#22c55e", "fill-opacity": 0.35 }}
              filter={conformeFilter}
            />
            <Layer
              id="conforme-line"
              source="parcelles"
              source-layer="parcelles"
              type="line"
              beforeId="error-type-top"
              paint={{ "line-color": "#16a34a", "line-width": 1, "line-opacity": 0.85 }}
              filter={conformeFilter}
            />
          </>
        )}

        {/* ── Parcelles à NICAD manquant / trop court (couleurs de l'accueil) ──
            Colorées directement depuis le vecteur (`_nstat`), indépendamment de la
            liste d'erreurs embarquée (plafonnée) : sinon seules les ~2000 premières
            erreurs seraient visibles alors qu'un gros DXF peut en porter 100k+. ── */}
        <Layer
          id="missing-nicad-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-type-top"
          paint={{ "fill-color": errorTypeColor("missing_nicad"), "fill-opacity": 0.5 }}
          filter={["all", ["==", ["get", "_nstat"], "missing"], notDeletedFilter] as any}
        />
        <Layer
          id="short-nicad-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-type-top"
          paint={{ "fill-color": errorTypeColor("short_nicad"), "fill-opacity": 0.5 }}
          filter={["all", ["==", ["get", "_nstat"], "short"], notDeletedFilter] as any}
        />

        {/* ── Parcelles SANS section rattachée (numero_section absent/« 000 ») ──
            La composante section de leur NICAD est indéterminée : signalées en
            orange directement depuis le vecteur (`_ssec`), sur toute l'analyse. ── */}
        {sansSectionHighlight && (
          <>
            <Layer
              id="sans-section-fill"
              source="parcelles"
              source-layer="parcelles"
              type="fill"
              beforeId="error-type-top"
              paint={{ "fill-color": SANS_SECTION_COLOR, "fill-opacity": 0.45 }}
              filter={["all", ["==", ["get", "_ssec"], 1], notDeletedFilter] as any}
            />
            <Layer
              id="sans-section-line"
              source="parcelles"
              source-layer="parcelles"
              type="line"
              beforeId="error-type-top"
              paint={{ "line-color": SANS_SECTION_COLOR, "line-width": 1.2, "line-opacity": 0.9 }}
              filter={["all", ["==", ["get", "_ssec"], 1], notDeletedFilter] as any}
            />
          </>
        )}

        {/* ── Error type fill overlays (below anchor) ── */}
        {errorTypes.map((type) => (
          <Layer
            key={`err-${type}`}
            id={`err-${type}`}
            source="parcelles"
            source-layer="parcelles"
            type="fill"
            beforeId="error-type-top"
            paint={{ "fill-color": errorTypeColor(type), "fill-opacity": 0.45 }}
            filter={["in", ["get", "_nicad"], ["literal", nicadsByType[type] ?? []]] as any}
          />
        ))}

        {/* ── Selection highlight (above error types, below error geometries) ── */}
        <Layer
          id="selected-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.38 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />
        <Layer
          id="selected-line"
          source="parcelles"
          source-layer="parcelles"
          type="line"
          beforeId="error-geoms-fill"
          paint={{ "line-color": "#60a5fa", "line-width": 2.5, "line-opacity": 1 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />

        {/* ── Searched parcel highlight (yellow) ── */}
        <Layer
          id="searched-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#facc15", "fill-opacity": 0.45 }}
          filter={["in", ["get", "_nicad"], ["literal", searchedNicads]] as any}
        />
        <Layer
          id="searched-line"
          source="parcelles"
          source-layer="parcelles"
          type="line"
          beforeId="error-geoms-fill"
          paint={{ "line-color": "#eab308", "line-width": 3, "line-opacity": 1 }}
          filter={["in", ["get", "_nicad"], ["literal", searchedNicads]] as any}
        />

        {/* ── Annotations des occurrences d'un doublon (centroïdes numérotés) ──
            En mode édition, chaque marqueur est cliquable : « conserver celle-ci »
            supprime les autres occurrences du même NICAD. ── */}
        {occurrences.map((o, i) => (
          <Marker key={`occ-${i}`} longitude={o.lng} latitude={o.lat} anchor="center">
            <div
              onClick={occurrenceEditMode ? () => onOccurrenceKeep?.(i) : undefined}
              title={
                occurrenceEditMode
                  ? `Conserver l'occurrence ${o.label} et supprimer les autres`
                  : `Occurrence ${o.label}`
              }
              style={{
                width: occurrenceEditMode ? 26 : 22,
                height: occurrenceEditMode ? 26 : 22,
                borderRadius: "50%",
                background: errorTypeColor("duplicate"),
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                border: `2px solid ${occurrenceEditMode ? "#fde047" : "#fff"}`,
                boxShadow: "0 1px 5px rgba(0,0,0,.45)",
                cursor: occurrenceEditMode ? "pointer" : "default",
                userSelect: "none",
              }}
            >
              {o.label}
            </div>
          </Marker>
        ))}

        {/* ── Étiquettes des numéros de section (marqueurs DOM : le style raster
            n'a pas de serveur de glyphes, une couche symbole ne rendrait rien).
            Masquées en vue large pour ne pas encombrer la carte. ── */}
        {showSections && sectionsData && zoom >= SECTION_LABEL_MIN_ZOOM &&
          sectionsData.labels.map((s, i) =>
            s.numSection ? (
              <Marker key={`sec-${i}`} longitude={s.lng} latitude={s.lat} anchor="center">
                <div
                  style={{
                    padding: "1px 7px",
                    borderRadius: 9999,
                    background: SECTION_COLOR,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    border: "1.5px solid #fff",
                    boxShadow: "0 1px 4px rgba(0,0,0,.4)",
                    whiteSpace: "nowrap",
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                >
                  {s.numSection}
                </div>
              </Marker>
            ) : null
          )}

        {/* ── Étiquettes des limites administratives (marqueurs DOM, zoom minimal par niveau) ── */}
        {adminLevels.map((level) => {
          const data = adminData[level];
          if (!data || zoom < ADMIN_STYLES[level].minLabelZoom) return null;
          const st = ADMIN_STYLES[level];
          return data.labels.map((lbl, i) => (
            <Marker key={`admin-${level}-${i}`} longitude={lbl.lng} latitude={lbl.lat} anchor="center">
              <div
                style={{
                  display: "inline-block",
                  whiteSpace: "nowrap",
                  padding: "1px 6px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,.85)",
                  color: st.color,
                  border: `1px solid ${st.color}`,
                  fontSize: st.fontSize,
                  fontWeight: 700,
                  textTransform: level === "regions" ? "uppercase" : "none",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              >
                {lbl.nom}
              </div>
            </Marker>
          ));
        })}

        {popup && (
          <Popup
            longitude={popup.lng}
            latitude={popup.lat}
            onClose={() => setPopup(null)}
            closeButton
            maxWidth="260px"
            offset={6}
          >
            <div style={{ fontSize: 11, lineHeight: 1.6, padding: "4px 2px", color: "#111827", background: "#fff" }}
              dangerouslySetInnerHTML={{ __html: popup.html }}
            />
          </Popup>
        )}
      </RMap>

      {/* ── Légende (petite, dynamique) ── */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 max-w-[180px] rounded-lg border border-border/60 bg-background/90 p-2 text-[11px] shadow-md backdrop-blur">
        <p className="mb-1 font-medium text-muted-foreground">Légende</p>
        <div className="space-y-1">
          {legendItems.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: item.color }}
              />
              <span className="text-foreground/90">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
