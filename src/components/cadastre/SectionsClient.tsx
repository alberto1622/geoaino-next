"use client";

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Upload, Loader2, Scissors, Combine, Trash2, EyeOff, AlertTriangle, CheckCircle, FileUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SectionItem {
  id: number;
  region: string | null;
  departement: string | null;
  commune: string | null;
  syscolCommune: string | null;
  numSection: string | null;
  surfaceM2: number | null;
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

interface OverlapItem {
  id: number;
  sectionAId: number;
  sectionBId: number;
  status: string;
  overlapAreaM2: number | null;
  intersectionGeoJson: GeoJSON.Geometry;
  aNumSection: string | null;
  aCommune: string | null;
  bNumSection: string | null;
  bCommune: string | null;
}

type JobState = { id: number; status: string; phase: string | null; progress: number; error?: string | null };

interface Batch {
  sourceFichier: string;
  nbSections: number;
  nbOverlapsPending: number;
  updatedAt: string;
}

// Couleurs des sections : une seule couleur pour les sections SAINES, une
// couleur d'alerte (ambre) pour celles impliquées dans un chevauchement en
// attente — la zone d'intersection elle-même reste dessinée en rouge par-dessus.
const SECTION_OK_COLOR = "#2563eb";
const SECTION_ERROR_COLOR = "#f59e0b";
function sectionColor(hasError: boolean): string {
  return hasError ? SECTION_ERROR_COLOR : SECTION_OK_COLOR;
}

const OVERLAP_COLOR = "#ef4444";

// ── Limites administratives (régions / départements / communes) ──────────────
// Contours + noms servis par /api/cadastre/admin-boundaries (dérivés de
// cad_communes_2026). `minLabelZoom` évite le nuage d'étiquettes en vue large.
type AdminLevel = "regions" | "departements" | "communes";
const ADMIN_LEVELS: AdminLevel[] = ["regions", "departements", "communes"];
const ADMIN_STYLES: Record<
  AdminLevel,
  { label: string; color: string; weight: number; dashArray?: string; minLabelZoom: number; fontSize: number }
> = {
  regions: { label: "Régions", color: "#b91c1c", weight: 3, minLabelZoom: 5, fontSize: 12 },
  departements: { label: "Départements", color: "#b45309", weight: 2, dashArray: "6 3", minLabelZoom: 7.5, fontSize: 12 },
  communes: { label: "Communes", color: "#0f766e", weight: 1.2, dashArray: "4 3", minLabelZoom: 9, fontSize: 10 },
};

interface AdminData {
  boundaries: GeoJSON.FeatureCollection;
  labels: Array<{ lng: number; lat: number; nom: string }>;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function SectionsClient() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const LRef = useRef<any>(null);
  const sectionsLayerRef = useRef<any>(null);
  const overlapsLayerRef = useRef<any>(null);

  const [mapReady, setMapReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [sourceFichier, setSourceFichier] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionItem[]>([]);
  const [overlaps, setOverlaps] = useState<OverlapItem[]>([]);
  const [selectedOverlapId, setSelectedOverlapId] = useState<number | null>(null);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [deletingSectionId, setDeletingSectionId] = useState<number | null>(null);
  // Jeu de sections déjà cadré : le fit global ne doit rejouer qu'au CHANGEMENT
  // de données, pas à chaque sélection (sinon il écrase le zoom sur sélection).
  const lastFittedRef = useRef<SectionItem[] | null>(null);
  // Limites administratives : bascule par niveau, données/couches en refs
  // (chargées une fois par niveau, à la première activation).
  const [adminShow, setAdminShow] = useState<Record<AdminLevel, boolean>>({
    regions: false,
    departements: false,
    communes: true,
  });
  const adminDataRef = useRef<Partial<Record<AdminLevel, AdminData>>>({});
  const adminFetchingRef = useRef<Set<AdminLevel>>(new Set());
  const adminLayersRef = useRef<Partial<Record<AdminLevel, { lines: any; labels: any }>>>({});
  const [adminFetchTick, setAdminFetchTick] = useState(0);
  const [mapZoom, setMapZoom] = useState(12);
  // Cartes des cartes de chevauchement dans la liste : pour y défiler quand une
  // section en erreur est cliquée sur la carte.
  const overlapItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // ── Init Leaflet (impératif, import dynamique — SSR-safe) ──────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapEl.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current).setView([14.7, -17.4], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;
      map.on("zoomend", () => setMapZoom(map.getZoom()));
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // `src = null` → toutes les sections stockées, tous lots confondus.
  const fetchData = useCallback(async (src: string | null) => {
    setLoadingData(true);
    setSourceFichier(src);
    try {
      const url = src
        ? `/api/cadastre/sections/overlaps?sourceFichier=${encodeURIComponent(src)}`
        : "/api/cadastre/sections/overlaps";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chargement échoué");
      setSections(data.sections ?? []);
      setOverlaps(data.overlaps ?? []);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoadingData(false);
    }
  }, []);

  const loadBatches = useCallback(async (): Promise<Batch[]> => {
    try {
      const res = await fetch("/api/cadastre/sections/batches");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chargement des lots échoué");
      setBatches(data.batches ?? []);
      return data.batches ?? [];
    } catch {
      return [];
    }
  }, []);

  // ── Chargement des données stockées au montage (affichage sans réimport) ───
  // TOUTES les sections (tous lots confondus) sont chargées au premier
  // chargement ; le sélecteur de lot permet ensuite de restreindre la vue.
  useEffect(() => {
    void (async () => {
      const list = await loadBatches();
      if (list.length > 0) await fetchData(null);
    })();
  }, [loadBatches, fetchData]);

  // ── Upload + lancement du job ──────────────────────────────────────────────
  const handleUpload = useCallback(async () => {
    if (files.length === 0) {
      toast.error("Sélectionnez un fichier DXF/DGN/ZIP.");
      return;
    }
    setUploading(true);
    setSections([]);
    setOverlaps([]);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await fetch("/api/cadastre/sections/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import échoué");
      setSourceFichier(data.sourceFichier);
      setJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
      setUploading(false);
    }
  }, [files]);

  // ── Polling du job jusqu'à complétion ──────────────────────────────────────
  useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.id}`);
        const j = await res.json();
        setJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, error: j.error });
        if (j.status === "completed") {
          setUploading(false);
          const src = (j.report?.sourceFichier as string) ?? sourceFichier;
          const nb = j.report?.nbSections ?? j.totalBuilt ?? 0;
          const ov = j.report?.nbOverlaps ?? 0;
          toast.success(`${nb} section(s) construites · ${ov} chevauchement(s) détecté(s).`);
          if (src) await fetchData(src);
          await loadBatches();
        } else if (j.status === "failed") {
          setUploading(false);
          toast.error(j.error || "Traitement échoué");
        }
      } catch {
        /* réessaie au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, sourceFichier, fetchData, loadBatches]);

  // Sections impliquées dans au moins un chevauchement EN ATTENTE : colorées
  // en alerte (ambre) — toutes les autres partagent la couleur unique.
  const pendingSectionIds = useMemo(() => {
    const ids = new Set<number>();
    for (const o of overlaps) {
      if (o.status !== "PENDING") continue;
      ids.add(o.sectionAId);
      ids.add(o.sectionBId);
    }
    return ids;
  }, [overlaps]);

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !mapReady) return;

    if (sectionsLayerRef.current) { map.removeLayer(sectionsLayerRef.current); sectionsLayerRef.current = null; }
    if (overlapsLayerRef.current) { map.removeLayer(overlapsLayerRef.current); overlapsLayerRef.current = null; }

    const secGroup = L.featureGroup();
    for (const s of sections) {
      if (!s.geomGeoJson) continue;
      const hasError = pendingSectionIds.has(s.id);
      const color = sectionColor(hasError);
      try {
        const gj = L.geoJSON(s.geomGeoJson as any, {
          style: hasError
            ? { color, weight: 2, fillColor: color, fillOpacity: 0.35 }
            : { color, weight: 1.2, fillColor: color, fillOpacity: 0.15 },
        });
        gj.bindTooltip(
          `Section <b>${s.numSection ?? "—"}</b><br/>${s.commune ?? "—"}` +
            (hasError ? "<br/><span style='color:#b45309'>⚠ chevauchement à corriger — cliquer pour le sélectionner</span>" : ""),
          { sticky: true },
        );
        if (hasError) {
          // Clic sur une section en erreur : sélectionne son chevauchement dans
          // la liste de droite (clics répétés = cycle si plusieurs).
          gj.on("click", (e: { originalEvent?: Event }) => {
            L.DomEvent.stopPropagation(e);
            const related = overlaps.filter(
              (o) => o.status === "PENDING" && (o.sectionAId === s.id || o.sectionBId === s.id),
            );
            if (related.length === 0) return;
            setSelectedOverlapId((prev) => {
              const idx = related.findIndex((o) => o.id === prev);
              return related[(idx + 1) % related.length].id;
            });
          });
        }
        gj.addTo(secGroup);
      } catch { /* ignore */ }
    }
    secGroup.addTo(map);
    sectionsLayerRef.current = secGroup;

    const ovGroup = L.featureGroup();
    for (const o of overlaps) {
      if (o.status !== "PENDING" || !o.intersectionGeoJson) continue;
      const isSel = o.id === selectedOverlapId;
      try {
        const gj = L.geoJSON(o.intersectionGeoJson as any, {
          style: { color: OVERLAP_COLOR, weight: isSel ? 3 : 1.5, fillColor: OVERLAP_COLOR, fillOpacity: isSel ? 0.7 : 0.45 },
        });
        gj.on("click", () => setSelectedOverlapId(o.id));
        gj.bindTooltip(`Chevauchement ${o.overlapAreaM2 != null ? `${Math.round(o.overlapAreaM2)} m²` : ""}`, { sticky: true });
        gj.addTo(ovGroup);
      } catch { /* ignore */ }
    }
    ovGroup.addTo(map);
    overlapsLayerRef.current = ovGroup;

    // Cadrage global uniquement quand le JEU de sections change (chargement,
    // changement de lot) — pas à chaque sélection de chevauchement.
    if (lastFittedRef.current !== sections) {
      lastFittedRef.current = sections;
      try {
        const b = secGroup.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [24, 24] });
      } catch { /* ignore */ }
    }
  }, [sections, overlaps, pendingSectionIds, selectedOverlapId, mapReady]);

  // ── Zoom sur le chevauchement sélectionné dans la table ────────────────────
  // Cadre les DEUX sections concernées (l'intersection seule est souvent un
  // sliver invisible) pour identifier la paire sur la carte.
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !mapReady || selectedOverlapId == null) return;
    const ov = overlaps.find((o) => o.id === selectedOverlapId);
    if (!ov) return;
    const geoms: GeoJSON.Geometry[] = [];
    const a = sections.find((s) => s.id === ov.sectionAId);
    const b = sections.find((s) => s.id === ov.sectionBId);
    if (a?.geomGeoJson) geoms.push(a.geomGeoJson);
    if (b?.geomGeoJson) geoms.push(b.geomGeoJson);
    if (geoms.length === 0 && ov.intersectionGeoJson) geoms.push(ov.intersectionGeoJson);
    try {
      let bounds: any = null;
      for (const g of geoms) {
        const gb = L.geoJSON(g as any).getBounds();
        if (!gb.isValid()) continue;
        bounds = bounds ? bounds.extend(gb) : gb;
      }
      if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17, animate: true });
      }
    } catch { /* ignore */ }
  }, [selectedOverlapId, overlaps, sections, mapReady]);

  // ── Défilement de la liste de droite vers le chevauchement sélectionné ─────
  useEffect(() => {
    if (selectedOverlapId == null) return;
    overlapItemRefs.current
      .get(selectedOverlapId)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedOverlapId]);

  // ── Limites administratives : (dé)montage des couches par niveau ───────────
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !mapReady) return;

    for (const level of ADMIN_LEVELS) {
      const style = ADMIN_STYLES[level];
      const existing = adminLayersRef.current[level];

      if (!adminShow[level]) {
        if (existing) {
          map.removeLayer(existing.lines);
          if (map.hasLayer(existing.labels)) map.removeLayer(existing.labels);
          adminLayersRef.current[level] = undefined;
        }
        continue;
      }

      const data = adminDataRef.current[level];
      if (!data) {
        // Chargement une seule fois par niveau (référentiel statique, cache HTTP).
        if (!adminFetchingRef.current.has(level)) {
          adminFetchingRef.current.add(level);
          void (async () => {
            try {
              const res = await fetch(`/api/cadastre/admin-boundaries?niveau=${level}`);
              const d = await res.json();
              if (!res.ok) throw new Error(d.error || "Chargement échoué");
              adminDataRef.current[level] = d as AdminData;
              setAdminFetchTick((t) => t + 1);
            } catch (err) {
              toast.error(`Limites ${style.label.toLowerCase()} : ${err}`);
            }
          })();
        }
        continue;
      }

      if (!existing) {
        const lines = L.geoJSON(data.boundaries as any, {
          style: { color: style.color, weight: style.weight, dashArray: style.dashArray, fill: false },
          interactive: false,
        });
        const labels = L.layerGroup();
        for (const lbl of data.labels) {
          const html =
            `<div style="transform:translate(-50%,-50%);display:inline-block;white-space:nowrap;` +
            `padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.85);` +
            `color:${style.color};border:1px solid ${style.color};font-size:${style.fontSize}px;font-weight:700;` +
            `${level === "regions" ? "text-transform:uppercase;" : ""}">${escHtml(lbl.nom)}</div>`;
          L.marker([lbl.lat, lbl.lng], {
            icon: L.divIcon({ className: "", html, iconSize: [0, 0] }),
            interactive: false,
            keyboard: false,
          }).addTo(labels);
        }
        lines.addTo(map);
        adminLayersRef.current[level] = { lines, labels };
      }

      // Étiquettes visibles seulement à partir du zoom du niveau (anti-nuage).
      const layer = adminLayersRef.current[level];
      if (!layer) continue;
      if (mapZoom >= style.minLabelZoom) {
        if (!map.hasLayer(layer.labels)) layer.labels.addTo(map);
      } else if (map.hasLayer(layer.labels)) {
        map.removeLayer(layer.labels);
      }
    }
  }, [adminShow, adminFetchTick, mapZoom, mapReady]);

  // ── Zoom sur une section précise (clic sur une ligne de la table Sections) ─
  const zoomToSection = useCallback((s: SectionItem) => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !s.geomGeoJson) return;
    try {
      const b = L.geoJSON(s.geomGeoJson as any).getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 17, animate: true });
    } catch { /* ignore */ }
  }, []);

  // ── Application d'une correction sur un chevauchement ──────────────────────
  const applyCorrection = useCallback(async (overlapId: number, action: string) => {
    setCorrecting(overlapId);
    try {
      const res = await fetch("/api/cadastre/sections/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlapId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Correction échouée");
      // En vue « tous les lots », la réponse (limitée au lot corrigé) ne doit
      // pas remplacer l'affichage complet : on recharge la vue courante.
      if (sourceFichier == null) {
        await fetchData(null);
      } else {
        setSections(data.sections ?? []);
        setOverlaps(data.overlaps ?? []);
      }
      setSelectedOverlapId(null);
      toast.success("Correction appliquée");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCorrecting(null);
    }
  }, [sourceFichier, fetchData]);

  // ── Suppression du lot chargé (toutes les sections du fichier sélectionné) ─
  const handleDeleteBatch = useCallback(async () => {
    if (!sourceFichier) return;
    const batch = batches.find((b) => b.sourceFichier === sourceFichier);
    const ok = window.confirm(
      `Supprimer les ${batch ? `${batch.nbSections} ` : ""}section(s) du fichier « ${sourceFichier} » ?\n` +
        "Les chevauchements associés seront aussi supprimés. Action irréversible.",
    );
    if (!ok) return;
    setDeletingBatch(true);
    try {
      const res = await fetch("/api/cadastre/sections/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFichier }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Suppression échouée");
      toast.success(`Lot « ${sourceFichier} » supprimé.`);
      const list = await loadBatches();
      if (list.length > 0) await fetchData(null);
      else {
        setSourceFichier(null);
        setSections([]);
        setOverlaps([]);
        setSelectedOverlapId(null);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeletingBatch(false);
    }
  }, [sourceFichier, batches, loadBatches, fetchData]);

  // ── Suppression d'une section individuelle (depuis la table) ───────────────
  const handleDeleteSection = useCallback(async (s: SectionItem) => {
    const ok = window.confirm(
      `Supprimer la section ${s.numSection ?? "—"}${s.commune ? ` (${s.commune})` : ""} ?`,
    );
    if (!ok) return;
    setDeletingSectionId(s.id);
    try {
      const res = await fetch("/api/cadastre/sections/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: s.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Suppression échouée");
      toast.success(`Section ${s.numSection ?? s.id} supprimée.`);
      // Retire localement la section et ses chevauchements, puis met à jour les compteurs de lots.
      setSections((prev) => prev.filter((x) => x.id !== s.id));
      setOverlaps((prev) => prev.filter((o) => o.sectionAId !== s.id && o.sectionBId !== s.id));
      setSelectedOverlapId((sel) =>
        overlaps.some((o) => o.id === sel && (o.sectionAId === s.id || o.sectionBId === s.id)) ? null : sel,
      );
      void loadBatches();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeletingSectionId(null);
    }
  }, [overlaps, loadBatches]);

  const pending = overlaps.filter((o) => o.status === "PENDING");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px] lg:items-start">
      {/* Colonne carte — collante : reste visible pendant le défilement de la
          liste des chevauchements à droite. */}
      <div className="space-y-3 lg:sticky lg:top-4">
        {/* Upload */}
        <div className="rounded-xl border border-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm hover:border-primary/50">
              <FileUp className="h-4 w-4 text-muted-foreground" />
              <span className="truncate max-w-[220px]">
                {files.length ? files.map((f) => f.name).join(", ") : "Choisir un DXF / DGN / ZIP"}
              </span>
              <input
                type="file"
                accept=".dxf,.dgn,.zip"
                multiple
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <Button size="sm" onClick={handleUpload} disabled={uploading || files.length === 0} className="gap-1.5">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? "Traitement…" : "Analyser les sections"}
            </Button>

            {batches.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Lot stocké :</span>
                <select
                  value={sourceFichier ?? ""}
                  onChange={(e) => void fetchData(e.target.value || null)}
                  className="h-8 max-w-[220px] rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">
                    Tous les lots — {batches.reduce((n, b) => n + b.nbSections, 0)} sect.
                  </option>
                  {batches.map((b) => (
                    <option key={b.sourceFichier} value={b.sourceFichier}>
                      {b.sourceFichier} — {b.nbSections} sect.{b.nbOverlapsPending > 0 ? ` · ${b.nbOverlapsPending} chev.` : ""}
                    </option>
                  ))}
                </select>
                {sourceFichier && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-400"
                    onClick={handleDeleteBatch}
                    disabled={deletingBatch}
                    title={`Supprimer toutes les sections du fichier « ${sourceFichier} »`}
                  >
                    {deletingBatch ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Supprimer le lot
                  </Button>
                )}
              </div>
            )}
          </div>
          {job && (job.status === "pending" || job.status === "running") && (
            <div className="mt-2">
              <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                <span>Phase : {job.phase ?? "…"}</span>
                <span>{job.progress}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-all" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Limites administratives (contours + noms) */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/60 px-3 py-2">
          <span className="text-xs text-muted-foreground">Limites admin :</span>
          {ADMIN_LEVELS.map((level) => {
            const st = ADMIN_STYLES[level];
            const active = adminShow[level];
            return (
              <Button
                key={level}
                size="sm"
                variant={active ? "default" : "outline"}
                className="h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => setAdminShow((prev) => ({ ...prev, [level]: !prev[level] }))}
                title={`Afficher les contours et noms : ${st.label.toLowerCase()}`}
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: st.color }} />
                {st.label}
              </Button>
            );
          })}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SECTION_OK_COLOR }} />
              Section OK
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SECTION_ERROR_COLOR }} />
              Chevauchement à corriger
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: OVERLAP_COLOR }} />
              Zone d&apos;intersection
            </span>
          </span>
        </div>

        <div className="relative">
          <div ref={mapEl} className="h-[600px] w-full rounded-xl border border-border/60" />
          {loadingData && (
            <div className="absolute right-3 top-3 rounded-lg bg-background/90 px-3 py-1.5 text-xs shadow">
              Chargement…
            </div>
          )}
        </div>
      </div>

      {/* Colonne latérale — hauteur bornée à l'écran, défilement interne :
          la carte reste fixe pendant qu'on parcourt les chevauchements. */}
      <div className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
        {/* Résumé + chevauchements */}
        <div className="rounded-xl border border-border/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Chevauchements</h3>
            <span className="text-xs text-muted-foreground">
              {sections.length} section{sections.length > 1 ? "s" : ""}
            </span>
          </div>

          {sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Importez un DXF pour extraire les sections et contrôler les chevauchements.
            </p>
          ) : pending.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" /> Aucun chevauchement à corriger.
            </p>
          ) : (
            <div className="space-y-2">
              {pending.map((o) => {
                const isSel = o.id === selectedOverlapId;
                const busy = correcting === o.id;
                return (
                  <div
                    key={o.id}
                    ref={(el) => {
                      if (el) overlapItemRefs.current.set(o.id, el);
                      else overlapItemRefs.current.delete(o.id);
                    }}
                    onClick={() => setSelectedOverlapId(o.id)}
                    className={[
                      "cursor-pointer rounded-lg border p-2.5 transition-all",
                      isSel ? "border-red-400/60 bg-red-500/5 ring-1 ring-red-400/30" : "border-border hover:border-red-400/30",
                    ].join(" ")}
                  >
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                      <span className="font-medium">
                        Section {o.aNumSection ?? "—"} ↔ {o.bNumSection ?? "—"}
                      </span>
                      {o.overlapAreaM2 != null && (
                        <span className="ml-auto text-muted-foreground">{Math.round(o.overlapAreaM2)} m²</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <ActBtn busy={busy} onClick={() => applyCorrection(o.id, "clip_a")} icon={<Scissors className="h-3 w-3" />}>
                        Découper {o.aNumSection ?? "A"}
                      </ActBtn>
                      <ActBtn busy={busy} onClick={() => applyCorrection(o.id, "clip_b")} icon={<Scissors className="h-3 w-3" />}>
                        Découper {o.bNumSection ?? "B"}
                      </ActBtn>
                      <ActBtn busy={busy} onClick={() => applyCorrection(o.id, "merge")} icon={<Combine className="h-3 w-3" />}>
                        Fusionner
                      </ActBtn>
                      <ActBtn busy={busy} onClick={() => applyCorrection(o.id, "ignore")} icon={<EyeOff className="h-3 w-3" />}>
                        Ignorer
                      </ActBtn>
                      <ActBtn busy={busy} danger onClick={() => applyCorrection(o.id, "delete_a")} icon={<Trash2 className="h-3 w-3" />}>
                        Suppr. {o.aNumSection ?? "A"}
                      </ActBtn>
                      <ActBtn busy={busy} danger onClick={() => applyCorrection(o.id, "delete_b")} icon={<Trash2 className="h-3 w-3" />}>
                        Suppr. {o.bNumSection ?? "B"}
                      </ActBtn>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Table des sections */}
        {sections.length > 0 && (
          <div className="rounded-xl border border-border/60 p-4">
            <h3 className="mb-2 text-sm font-semibold">Sections ({sections.length})</h3>
            <div className="max-h-[280px] overflow-auto">
              <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Sect.</th>
                    <th className="py-1 pr-2 font-medium">Commune</th>
                    <th className="py-1 pr-2 font-medium">Dépt</th>
                    <th className="py-1 pr-2 font-medium text-right">m²</th>
                    <th className="py-1 font-medium" aria-label="Supprimer" />
                  </tr>
                </thead>
                <tbody>
                  {sections.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => zoomToSection(s)}
                      title={`Zoomer sur la section ${s.numSection ?? "—"}`}
                      className="cursor-pointer border-t border-border/40 transition-colors hover:bg-secondary/40"
                    >
                      <td className="py-1 pr-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ background: sectionColor(pendingSectionIds.has(s.id)) }}
                          />
                          {s.numSection ?? "—"}
                        </span>
                      </td>
                      <td className="py-1 pr-2 truncate max-w-[110px]">{s.commune ?? "—"}</td>
                      <td className="py-1 pr-2 truncate max-w-[90px]">{s.departement ?? "—"}</td>
                      <td className="py-1 pr-2 text-right font-mono">{s.surfaceM2 != null ? Math.round(s.surfaceM2).toLocaleString("fr-FR") : "—"}</td>
                      <td className="py-1 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteSection(s); }}
                          disabled={deletingSectionId === s.id}
                          title={`Supprimer la section ${s.numSection ?? "—"}`}
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                        >
                          {deletingSectionId === s.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Trash2 className="h-3 w-3" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActBtn({
  children, onClick, icon, busy, danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon: React.ReactNode;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={busy}
      className={[
        "flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-40",
        danger
          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "bg-secondary text-foreground hover:bg-secondary/70",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}
