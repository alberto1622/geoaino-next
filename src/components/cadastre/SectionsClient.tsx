"use client";

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CadHistoryPanel } from "@/components/cadastre/CadHistoryPanel";
import { toast } from "sonner";
import { notifyAnalysesUpdated } from "@/lib/analyses/live-refresh";
import {
  Upload,
  Loader2,
  Scissors,
  Combine,
  Trash2,
  EyeOff,
  AlertTriangle,
  CheckCircle,
  FileUp,
  Download,
  X,
  ChevronsLeft,
  ChevronsRight,
  Layers,
  History,
  ChevronDown,
  Pencil,
  Check,
  Tag,
  ListOrdered,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import FieldMappingModal from "@/components/FieldMappingModal";
import type { TargetFieldDef } from "@/lib/import/field-mapping";

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

type JobState = {
  id: number;
  status: string;
  phase: string | null;
  progress: number;
  error?: string | null;
};

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
// Même couleur que `SANS_SECTION_COLOR` (MapLibreMap.tsx) : une section sans
// numéro sur cette carte QA correspond aux parcelles orphelines de section
// sur la carte d'analyse — un seul code couleur pour le même concept partout.
const SECTION_UNNUMBERED_COLOR = "#f97316";
function sectionColor(hasError: boolean, unnumbered = false): string {
  if (hasError) return SECTION_ERROR_COLOR;
  if (unnumbered) return SECTION_UNNUMBERED_COLOR;
  return SECTION_OK_COLOR;
}

const OVERLAP_COLOR = "#ef4444";
// Sections sélectionnées pour une fusion manuelle (violet).
const MERGE_COLOR = "#8b5cf6";

// ── Limites administratives (régions / départements / communes) ──────────────
// Contours + noms servis par /api/cadastre/admin-boundaries (dérivés de
// cad_communes_2026). `minLabelZoom` évite le nuage d'étiquettes en vue large.
type AdminLevel = "regions" | "departements" | "communes";
const ADMIN_LEVELS: AdminLevel[] = ["regions", "departements", "communes"];
const ADMIN_STYLES: Record<
  AdminLevel,
  {
    label: string;
    color: string;
    weight: number;
    dashArray?: string;
    minLabelZoom: number;
    fontSize: number;
  }
> = {
  regions: {
    label: "Régions",
    color: "#b91c1c",
    weight: 3,
    minLabelZoom: 5,
    fontSize: 12,
  },
  departements: {
    label: "Départements",
    color: "#b45309",
    weight: 2,
    dashArray: "6 3",
    minLabelZoom: 7.5,
    fontSize: 12,
  },
  communes: {
    label: "Communes",
    color: "#0f766e",
    weight: 1.2,
    dashArray: "4 3",
    minLabelZoom: 9,
    fontSize: 10,
  },
};

interface AdminData {
  boundaries: GeoJSON.FeatureCollection;
  labels: Array<{ lng: number; lat: number; nom: string }>;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BATCH_ACTION_LABELS = {
  clip_a: "Découper la section A",
  clip_b: "Découper la section B",
  auto: "Découper automatiquement (garder la plus petite section)",
  ignore: "Ignorer",
} as const;

export default function SectionsClient() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const LRef = useRef<any>(null);
  const sectionsLayerRef = useRef<any>(null);
  const overlapsLayerRef = useRef<any>(null);
  // Couches par id (sections et intersections) : sélections restylées en place
  // SANS reconstruire les couches (sinon un popup ouvert serait refermé).
  const sectionLayersRef = useRef<Map<number, any>>(new Map());
  const overlapLayersRef = useRef<Map<number, any>>(new Map());

  const [mapReady, setMapReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [pendingShapefileInventory, setPendingShapefileInventory] = useState<{
    fileKey: string;
    fileName: string;
    fields: { name: string; sampleValues: string[] }[];
    targetFields: TargetFieldDef[];
    proposedMapping: Record<string, string>;
  } | null>(null);
  const [sourceFichier, setSourceFichier] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionItem[]>([]);
  const [overlaps, setOverlaps] = useState<OverlapItem[]>([]);
  const [selectedOverlapId, setSelectedOverlapId] = useState<number | null>(
    null,
  );
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [deletingSectionId, setDeletingSectionId] = useState<number | null>(
    null,
  );
  // Attribution des NICAD manquants (incrémentation par plus proche voisin) —
  // id de la section en cours de traitement (aperçu ou application).
  const [fillingNicadId, setFillingNicadId] = useState<number | null>(null);
  // Panneau latéral (chevauchements + sections) superposé à la carte, repliable.
  const [panelOpen, setPanelOpen] = useState(true);
  // Confirmation en attente pour les actions destructives (remplace window.confirm).
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  // Panneau "Historique" des modifications sections/parcelles (delete pour l'instant).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Fusion manuelle : ids sélectionnés DANS L'ORDRE (le premier conserve ses
  // attributs). Ref miroir pour lecture dans les popups Leaflet (impératifs).
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  const mergeSelectionRef = useRef<number[]>([]);
  const [merging, setMerging] = useState(false);
  // Attribution de numéro pour une section qui n'en a pas — édition inline
  // partagée par la table et le popup carte (même handler performSetNumero).
  const [numeroEditId, setNumeroEditId] = useState<number | null>(null);
  const [numeroDraft, setNumeroDraft] = useState("");
  const [savingNumero, setSavingNumero] = useState<number | null>(null);
  // Filtre "Sans numéro" : restreint table ET carte aux sections numSection === null.
  const [showUnnumberedOnly, setShowUnnumberedOnly] = useState(false);
  // Sélection multiple de chevauchements pour un traitement groupé (découpe
  // A/B, auto, ignorer) — même principe que `mergeSelection` mais restreinte
  // aux chevauchements PENDING (voir `activeOverlapSelection` plus bas).
  const [overlapSelection, setOverlapSelection] = useState<number[]>([]);
  const [batchCorrecting, setBatchCorrecting] = useState(false);
  // Ref miroir pour lecture dans le popup carte (impératif, cf. mergeSelectionRef).
  const batchCorrectingRef = useRef(false);
  // Recadrage global : uniquement quand la PORTÉE des données change (premier
  // chargement, changement de lot) — jamais après une correction, fusion ou
  // suppression, sinon l'utilisateur perd sa vue zoomée à chaque action.
  const fitPendingRef = useRef(false);
  const lastScopeRef = useRef<string | null | undefined>(undefined);
  // Limites administratives : bascule par niveau, données/couches en refs
  // (chargées une fois par niveau, à la première activation).
  const [adminShow, setAdminShow] = useState<Record<AdminLevel, boolean>>({
    regions: false,
    departements: false,
    communes: false,
  });
  const adminDataRef = useRef<Partial<Record<AdminLevel, AdminData>>>({});
  const adminFetchingRef = useRef<Set<AdminLevel>>(new Set());
  const adminLayersRef = useRef<
    Partial<Record<AdminLevel, { lines: any; labels: any }>>
  >({});
  const [adminFetchTick, setAdminFetchTick] = useState(0);
  const [mapZoom, setMapZoom] = useState(12);
  // Étiquettes de numéro de section sur la carte : masquables (encombrant sur
  // les gros lots) — bascule à côté des limites admin.
  const [showSectionLabels, setShowSectionLabels] = useState(false);
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
      // Vue initiale : emprise du Sénégal entier (recadrée ensuite sur les
      // données via fitBounds quand un lot est chargé).
      const map = L.map(mapEl.current).fitBounds([
        [12.3, -17.6],
        [16.7, -11.3],
      ]);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;
      map.on("zoomend", () => setMapZoom(map.getZoom()));
      // Le conteneur est dimensionné en flex (hauteur = espace restant de
      // l'écran) : Leaflet doit recalculer sa taille quand elle change.
      if (typeof ResizeObserver !== "undefined" && mapEl.current) {
        resizeObsRef.current = new ResizeObserver(() => map.invalidateSize());
        resizeObsRef.current.observe(mapEl.current);
      }
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
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
    // `undefined` = jamais chargé : le premier chargement recadre toujours.
    if (lastScopeRef.current !== src) {
      lastScopeRef.current = src;
      fitPendingRef.current = true;
    }
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

  // ── Notification de fin de construction (job DXF/DGN ou shapefile synchrone) ─
  const reportBuildResult = useCallback(
    async (report: {
      sourceFichier: string;
      nbSections: number;
      nbOverlaps: number;
      nbResidusFusionnes?: number;
      nbResidusEcartes?: number;
      nbEnveloppesEcartees?: number;
    }) => {
      setUploading(false);
      const fus = report.nbResidusFusionnes ?? 0;
      const res =
        (report.nbResidusEcartes ?? 0) + (report.nbEnveloppesEcartees ?? 0);
      toast.success(
        `${report.nbSections} section(s) construites · ${report.nbOverlaps} chevauchement(s) détecté(s)` +
          (fus > 0 ? ` · ${fus} résidu(s) fusionné(s) à leur section` : "") +
          (res > 0 ? ` · ${res} résidu(s)/enveloppe(s) écarté(s)` : "") +
          ".",
      );
      await fetchData(report.sourceFichier);
      await loadBatches();
    },
    [fetchData, loadBatches],
  );

  // ── Upload + lancement du job (DXF/DGN/ZIP) ou construction directe (shapefile) ─
  const handleUpload = useCallback(async () => {
    if (files.length === 0) {
      toast.error(
        "Sélectionnez un fichier DXF/DGN/ZIP ou un shapefile (.shp + .dbf).",
      );
      return;
    }
    setUploading(true);
    setSections([]);
    setOverlaps([]);
    const isShapefile = files.some((f) =>
      f.name.toLowerCase().endsWith(".shp"),
    );
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);

      if (isShapefile) {
        // Shapefile : même parcours que le DXF désormais — inventaire des
        // colonnes .dbf, mappage du numéro de section, puis job asynchrone
        // (kind "sections", même table limite_section).
        const invRes = await fetch("/api/cadastre/import/inventory", {
          method: "POST",
          body: (() => {
            const invFd = new FormData();
            invFd.append("target", "sections-limite");
            for (const f of files) invFd.append("files", f);
            return invFd;
          })(),
        });
        const inv = await invRes.json();
        if (!invRes.ok) throw new Error(inv.error || "Inventaire échoué");
        setUploading(false);
        setPendingShapefileInventory(inv);
        return;
      }

      const res = await fetch("/api/cadastre/sections/import", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import échoué");
      setSourceFichier(data.sourceFichier);
      setJob({
        id: data.jobId,
        status: data.status,
        phase: "read",
        progress: 0,
      });
    } catch (err) {
      toast.error(String(err));
      setUploading(false);
    }
  }, [files]);

  const startShapefileSectionsJob = useCallback(
    async (mapping: Record<string, string>) => {
      if (!pendingShapefileInventory) return;
      const inv = pendingShapefileInventory;
      setPendingShapefileInventory(null);
      setUploading(true);
      try {
        const res = await fetch("/api/import-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey: inv.fileKey,
            fileName: inv.fileName,
            sourceType: "SHP",
            kind: "sections",
            layerMapping: mapping,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import échoué");
        setSourceFichier(inv.fileName);
        setJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
      } catch (err) {
        toast.error(String(err));
        setUploading(false);
      }
    },
    [pendingShapefileInventory],
  );

  const handleCancelJob = useCallback(async () => {
    if (!job) return;
    await fetch(`/api/import-jobs/${job.id}/cancel`, { method: "POST" });
  }, [job]);

  // ── Polling du job jusqu'à complétion ──────────────────────────────────────
  useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.id}`);
        const j = await res.json();
        setJob({
          id: j.id,
          status: j.status,
          phase: j.phase,
          progress: j.progress,
          error: j.error,
        });
        if (j.status === "completed") {
          const src = (j.report?.sourceFichier as string) ?? sourceFichier;
          if (src) {
            await reportBuildResult({
              sourceFichier: src,
              nbSections: j.report?.nbSections ?? j.totalBuilt ?? 0,
              nbOverlaps: j.report?.nbOverlaps ?? 0,
              nbResidusFusionnes: j.report?.nbResidusFusionnes ?? 0,
              nbResidusEcartes: j.report?.nbResidusEcartes ?? 0,
              nbEnveloppesEcartees: j.report?.nbEnveloppesEcartees ?? 0,
            });
          } else {
            setUploading(false);
          }
        } else if (j.status === "failed") {
          setUploading(false);
          toast.error(j.error || "Traitement échoué");
        } else if (j.status === "cancelled") {
          setUploading(false);
          toast.info("Import annulé.");
        }
      } catch {
        /* réessaie au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, sourceFichier, reportBuildResult]);

  // ── Suppression d'une section individuelle (table OU popup carte) ──────────
  // Une zone récupérée à tort comme section (enveloppe, quartier, artefact) se
  // repère surtout visuellement : la carte doit permettre de la supprimer.
  const performDeleteSection = useCallback(
    async (s: SectionItem) => {
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
        setOverlaps((prev) =>
          prev.filter((o) => o.sectionAId !== s.id && o.sectionBId !== s.id),
        );
        setSelectedOverlapId((sel) =>
          overlaps.some(
            (o) =>
              o.id === sel && (o.sectionAId === s.id || o.sectionBId === s.id),
          )
            ? null
            : sel,
        );
        void loadBatches();
      } catch (err) {
        toast.error(String(err));
      } finally {
        setDeletingSectionId(null);
      }
    },
    [overlaps, loadBatches],
  );

  const handleDeleteSection = useCallback(
    (s: SectionItem) => {
      setConfirmState({
        title: "Supprimer la section",
        description: `Supprimer la section ${s.numSection ?? "—"}${s.commune ? ` (${s.commune})` : ""} ?\nRestaurable ensuite depuis le panneau Historique.`,
        confirmLabel: "Supprimer",
        run: () => void performDeleteSection(s),
      });
    },
    [performDeleteSection],
  );

  // ── Attribution des NICAD manquants (incrémentation par plus proche voisin,
  // à partir du dernier numéro connu dans la section) ────────────────────────
  // Contrairement à la synchro NICAD (qui reconstruit un NICAD déjà complet),
  // cette action CRÉE des identifiants à partir de rien : déclenchement
  // volontaire (bouton dédié) avec aperçu chiffré avant confirmation, pas
  // d'application automatique.
  const performFillMissingNicad = useCallback(async (s: SectionItem) => {
    setFillingNicadId(s.id);
    try {
      const res = await fetch("/api/cadastre/sections/nicad-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: s.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Attribution échouée");
      const result = data.result as {
        parcelsAssigned: number;
        unresolvedCount: number;
        analysisIds: number[];
        plans: { fromParcelle: string; toParcelle: string; viaCommune2026?: boolean; communeApprox?: boolean }[];
      };
      if (result.parcelsAssigned === 0) {
        toast.info("Aucune parcelle n'a pu être numérotée.");
        return;
      }
      const range =
        result.plans.length === 1
          ? ` (${result.plans[0].fromParcelle} → ${result.plans[0].toParcelle})`
          : "";
      toast.success(`${result.parcelsAssigned} NICAD attribué(s)${range}.`);
      if (result.unresolvedCount > 0) {
        toast.warning(
          `${result.unresolvedCount} parcelle(s) sans NICAD non traitée(s) (aucune parcelle déjà numérotée dans leur analyse pour servir de référence).`,
        );
      }
      if (result.plans.some((p) => p.viaCommune2026)) {
        toast.warning(
          result.plans.some((p) => p.communeApprox)
            ? "Préfixe territorial déduit de la commune 2026 par proximité (aucune parcelle de référence dans la section) — à vérifier."
            : "Préfixe territorial déduit de la commune 2026 (aucune parcelle de référence dans la section) — à vérifier.",
        );
      }
      notifyAnalysesUpdated(result.analysisIds ?? []);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setFillingNicadId(null);
    }
  }, []);

  const handleFillMissingNicad = useCallback(
    async (s: SectionItem) => {
      if (!s.numSection) {
        toast.error("Attribuez d'abord un numéro à cette section.");
        return;
      }
      setFillingNicadId(s.id);
      try {
        const res = await fetch("/api/cadastre/sections/nicad-fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sectionId: s.id, dryRun: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Aperçu échoué");
        const result = data.result as {
          parcelsAssigned: number;
          unresolvedCount: number;
          plans: { fromParcelle: string; toParcelle: string; viaCommune2026?: boolean; communeApprox?: boolean }[];
        };
        if (result.parcelsAssigned === 0) {
          toast.info(
            result.unresolvedCount > 0
              ? `${result.unresolvedCount} parcelle(s) sans NICAD, mais aucune parcelle déjà numérotée dans cette section pour servir de référence.`
              : "Aucune parcelle sans NICAD dans cette section.",
          );
          return;
        }
        const range =
          result.plans.length === 1
            ? `de ${result.plans[0].fromParcelle} à ${result.plans[0].toParcelle}`
            : `${result.plans.length} lot(s) concernés`;
        const viaCommune2026Note = result.plans.some((p) => p.viaCommune2026)
          ? "\nAucune parcelle déjà numérotée dans cette section : préfixe territorial déduit de la commune 2026" +
            (result.plans.some((p) => p.communeApprox) ? " (par proximité)" : "") +
            ", à vérifier."
          : "";
        setConfirmState({
          title: "Attribuer les NICAD manquants",
          description:
            `Attribuer ${result.parcelsAssigned} NICAD (${range}) aux parcelles sans NICAD de la section ${s.numSection} ?\n` +
            "Numérotation par plus proche voisin à partir du dernier numéro connu." +
            viaCommune2026Note,
          confirmLabel: "Attribuer",
          run: () => void performFillMissingNicad(s),
        });
      } catch (err) {
        toast.error(String(err));
      } finally {
        setFillingNicadId(null);
      }
    },
    [performFillMissingNicad],
  );

  // ── Sélection pour fusion manuelle ──────────────────────────────────────────
  const toggleMergeSelection = useCallback((id: number) => {
    setMergeSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleOverlapSelection = useCallback((id: number) => {
    setOverlapSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  // Sélection restreinte aux sections encore affichées : les ids disparus
  // (suppression, changement de lot) deviennent inertes sans setState d'effet.
  const activeMergeSelection = useMemo(
    () => mergeSelection.filter((id) => sections.some((s) => s.id === id)),
    [mergeSelection, sections],
  );

  useEffect(() => {
    mergeSelectionRef.current = activeMergeSelection;
  }, [activeMergeSelection]);

  useEffect(() => {
    batchCorrectingRef.current = batchCorrecting;
  }, [batchCorrecting]);

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

  // ── Attribution d'un numéro à une section qui n'en a pas ────────────────────
  // Handler partagé par la table (édition inline) et le popup carte (Task 4).
  const performSetNumero = useCallback(
    async (sectionId: number, rawValue: string) => {
      const numSection = rawValue.trim();
      if (!numSection) {
        toast.error("Le numéro ne peut pas être vide.");
        return;
      }
      setSavingNumero(sectionId);
      try {
        const res = await fetch("/api/cadastre/sections/numero", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sectionId, numSection }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Attribution échouée");
        setSections((prev) =>
          prev.map((s) => (s.id === sectionId ? { ...s, numSection } : s)),
        );
        setNumeroEditId(null);

        const sync = data.nicadSync as
          | {
              parcelsUpdated: number;
              conflicts: unknown[];
              errorsResolved: number;
              analysisIds: number[];
            }
          | null
          | undefined;
        if (sync && sync.parcelsUpdated > 0) {
          const conflictSuffix =
            sync.conflicts.length > 0
              ? `, ${sync.conflicts.length} conflit(s) ignoré(s)`
              : "";
          const errorsSuffix =
            sync.errorsResolved > 0
              ? `, ${sync.errorsResolved} doublure(s) résolue(s)`
              : "";
          toast.success(
            `Numéro ${numSection} enregistré — ${sync.parcelsUpdated} NICAD mis à jour${errorsSuffix}${conflictSuffix}.`,
          );
          // Notifie un éventuel onglet /map/[id] déjà ouvert sur une des analyses
          // touchées : rafraîchit tuiles (couleurs) + KPI sans rechargement manuel.
          notifyAnalysesUpdated(sync.analysisIds ?? []);
        } else if (data.nicadSyncError) {
          toast.warning(
            `Numéro ${numSection} enregistré. ${data.nicadSyncError}`,
          );
        } else {
          toast.success(`Numéro ${numSection} attribué.`);
        }
      } catch (err) {
        toast.error(String(err));
      } finally {
        setSavingNumero(null);
      }
    },
    [],
  );

  const unnumberedCount = useMemo(
    () => sections.filter((s) => !s.numSection).length,
    [sections],
  );
  // Sections effectivement dessinées/listées — restreintes aux non numérotées
  // quand le filtre "Sans numéro" est actif.
  const displayedSections = useMemo(
    () =>
      showUnnumberedOnly ? sections.filter((s) => !s.numSection) : sections,
    [sections, showUnnumberedOnly],
  );

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map || !mapReady) return;

    if (sectionsLayerRef.current) {
      map.removeLayer(sectionsLayerRef.current);
      sectionsLayerRef.current = null;
    }
    if (overlapsLayerRef.current) {
      map.removeLayer(overlapsLayerRef.current);
      overlapsLayerRef.current = null;
    }

    const secGroup = L.featureGroup();
    sectionLayersRef.current.clear();
    for (const s of displayedSections) {
      if (!s.geomGeoJson) continue;
      const hasError = pendingSectionIds.has(s.id);
      const unnumbered = !s.numSection;
      const color = sectionColor(hasError, unnumbered);
      try {
        const gj = L.geoJSON(s.geomGeoJson as any, {
          style:
            hasError || unnumbered
              ? { color, weight: 2, fillColor: color, fillOpacity: 0.35 }
              : { color, weight: 1.2, fillColor: color, fillOpacity: 0.15 },
        });
        gj.bindTooltip(
          `Section <b>${escHtml(s.numSection ?? "—")}</b><br/>${escHtml(s.commune ?? "—")}` +
            (hasError
              ? "<br/><span style='color:#b45309'>⚠ chevauchement à corriger — cliquer pour le sélectionner</span>"
              : unnumbered
                ? `<br/><span style='color:${SECTION_UNNUMBERED_COLOR}'>⚠ sans numéro — cliquer pour en attribuer un</span>`
                : "<br/><span style='opacity:.7'>cliquer : détails / supprimer</span>"),
          { sticky: true },
        );
        // Popup au clic : identité de la zone + suppression directe depuis la
        // carte (une zone récupérée à tort comme section se repère à l'œil).
        const popup = document.createElement("div");
        popup.style.cssText = "font-size:12px;min-width:170px";
        const info = document.createElement("div");
        info.innerHTML =
          `<b>Section ${escHtml(s.numSection ?? "—")}</b><br/>${escHtml(s.commune ?? "—")}` +
          (s.surfaceM2 != null
            ? `<br/>${Math.round(s.surfaceM2).toLocaleString("fr-FR")} m²`
            : "");
        // Champ d'attribution/modification du numéro directement dans le popup
        // (attribution si absent, modification sinon — recalcule les NICAD rattachés).
        const numeroWrap = document.createElement("div");
        numeroWrap.style.cssText = "margin-top:6px;display:flex;gap:4px";
        const numeroInput = document.createElement("input");
        numeroInput.type = "text";
        numeroInput.placeholder = "N° section";
        numeroInput.value = s.numSection ?? "";
        numeroInput.style.cssText =
          "flex:1;min-width:0;padding:3px 6px;font-size:11px;border-radius:6px;" +
          "border:1px solid #f59e0b;background:transparent;color:inherit";
        const numeroBtn = document.createElement("button");
        numeroBtn.type = "button";
        numeroBtn.textContent = s.numSection ? "Modifier" : "Attribuer";
        numeroBtn.style.cssText =
          "padding:3px 8px;font-size:11px;border-radius:6px;" +
          "border:1px solid #f59e0b;color:#f59e0b;background:transparent;cursor:pointer";
        const submitNumero = () => {
          if (batchCorrectingRef.current) return;
          const val = numeroInput.value.trim();
          if (!val) return;
          map.closePopup();
          void performSetNumero(s.id, val);
        };
        numeroBtn.onclick = submitNumero;
        numeroInput.onkeydown = (e: KeyboardEvent) => {
          if (e.key === "Enter") submitNumero();
        };
        // Correction groupée en cours : ce bouton reste inerte (la réponse
        // du batch écrase `sections` — cf. batchCorrecting).
        const syncNumeroBtn = () => {
          numeroBtn.disabled = batchCorrectingRef.current;
        };
        syncNumeroBtn();
        gj.on("popupopen", syncNumeroBtn);
        numeroWrap.appendChild(numeroInput);
        numeroWrap.appendChild(numeroBtn);
        const mergeBtn = document.createElement("button");
        mergeBtn.type = "button";
        mergeBtn.style.cssText =
          "margin-top:6px;width:100%;padding:3px 8px;font-size:11px;border-radius:6px;" +
          `border:1px solid ${MERGE_COLOR};color:${MERGE_COLOR};background:transparent;cursor:pointer`;
        // Libellé recalculé à chaque ouverture : la sélection évolue sans que
        // les couches (et donc ce popup) soient reconstruites.
        const syncMergeBtn = () => {
          mergeBtn.textContent = mergeSelectionRef.current.includes(s.id)
            ? "Retirer de la fusion"
            : "Sélectionner pour fusionner";
        };
        syncMergeBtn();
        gj.on("popupopen", syncMergeBtn);
        mergeBtn.onclick = () => {
          toggleMergeSelection(s.id);
          map.closePopup();
        };
        // Attribution des NICAD manquants : seulement pour une section déjà
        // numérotée (le NICAD encode son numéro).
        let fillNicadBtn: HTMLButtonElement | null = null;
        if (s.numSection) {
          fillNicadBtn = document.createElement("button");
          fillNicadBtn.type = "button";
          fillNicadBtn.textContent = "Attribuer les NICAD manquants";
          fillNicadBtn.style.cssText =
            "margin-top:6px;width:100%;padding:3px 8px;font-size:11px;border-radius:6px;" +
            "border:1px solid #2563eb;color:#2563eb;background:transparent;cursor:pointer";
          fillNicadBtn.onclick = () => {
            if (batchCorrectingRef.current) return;
            map.closePopup();
            void handleFillMissingNicad(s);
          };
        }
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "Supprimer cette section";
        delBtn.style.cssText =
          "margin-top:6px;width:100%;padding:3px 8px;font-size:11px;border-radius:6px;" +
          "border:1px solid #ef4444;color:#ef4444;background:transparent;cursor:pointer";
        delBtn.onclick = () => {
          map.closePopup();
          void handleDeleteSection(s);
        };
        popup.appendChild(info);
        popup.appendChild(numeroWrap);
        popup.appendChild(mergeBtn);
        popup.appendChild(delBtn);
        gj.bindPopup(popup);
        if (hasError) {
          // Clic sur une section en erreur : sélectionne son chevauchement dans
          // la liste de droite (clics répétés = cycle si plusieurs).
          gj.on("click", (e: { originalEvent?: Event }) => {
            L.DomEvent.stopPropagation(e);
            const related = overlaps.filter(
              (o) =>
                o.status === "PENDING" &&
                (o.sectionAId === s.id || o.sectionBId === s.id),
            );
            if (related.length === 0) return;
            setSelectedOverlapId((prev) => {
              const idx = related.findIndex((o) => o.id === prev);
              return related[(idx + 1) % related.length].id;
            });
            setPanelOpen(true);
          });
        }
        gj.addTo(secGroup);
        sectionLayersRef.current.set(s.id, gj);
        // Étiquette permanente du numéro de section (pas seulement au survol/clic) —
        // même pattern que les labels des limites administratives ci-dessous.
        if (s.numSection && showSectionLabels) {
          const center = gj.getBounds().getCenter();
          const labelHtml =
            `<div style="color:${color};font-size:10px;font-weight:700;` +
            `text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 2px #fff;` +
            `white-space:nowrap;pointer-events:none">${escHtml(s.numSection)}</div>`;
          L.marker(center, {
            icon: L.divIcon({
              className: "",
              html: labelHtml,
              iconSize: [0, 0],
            }),
            interactive: false,
            keyboard: false,
          }).addTo(secGroup);
        }
      } catch {
        /* ignore */
      }
    }
    secGroup.addTo(map);
    sectionsLayerRef.current = secGroup;

    const ovGroup = L.featureGroup();
    overlapLayersRef.current.clear();
    for (const o of overlaps) {
      if (o.status !== "PENDING" || !o.intersectionGeoJson) continue;
      try {
        const gj = L.geoJSON(o.intersectionGeoJson as any, {
          style: {
            color: OVERLAP_COLOR,
            weight: 1.5,
            fillColor: OVERLAP_COLOR,
            fillOpacity: 0.45,
          },
        });
        gj.on("click", () => {
          setSelectedOverlapId(o.id);
          setPanelOpen(true);
        });
        gj.bindTooltip(
          `Chevauchement ${o.overlapAreaM2 != null ? `${Math.round(o.overlapAreaM2)} m²` : ""}`,
          { sticky: true },
        );
        gj.addTo(ovGroup);
        overlapLayersRef.current.set(o.id, gj);
      } catch {
        /* ignore */
      }
    }
    ovGroup.addTo(map);
    overlapsLayerRef.current = ovGroup;

    // Cadrage global uniquement si un changement de portée est en attente
    // (premier chargement, changement de lot) — les corrections, fusions et
    // suppressions redessinent SANS toucher à la vue courante.
    if (fitPendingRef.current && displayedSections.length > 0) {
      fitPendingRef.current = false;
      try {
        const b = secGroup.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [24, 24] });
      } catch {
        /* ignore */
      }
    }
  }, [
    displayedSections,
    overlaps,
    pendingSectionIds,
    mapReady,
    handleDeleteSection,
    toggleMergeSelection,
    performSetNumero,
    handleFillMissingNicad,
    showSectionLabels,
  ]);

  // ── Surbrillance des sections sélectionnées pour fusion (restylage seul) ───
  // Rejoue aussi après chaque reconstruction des couches (styles de base).
  useEffect(() => {
    const sel = new Set(activeMergeSelection);
    const unnumberedIds = new Set(
      displayedSections.filter((s) => !s.numSection).map((s) => s.id),
    );
    for (const [id, layer] of sectionLayersRef.current) {
      const hasError = pendingSectionIds.has(id);
      const unnumbered = unnumberedIds.has(id);
      const color = sectionColor(hasError, unnumbered);
      try {
        layer.setStyle(
          sel.has(id)
            ? {
                color: MERGE_COLOR,
                weight: 3,
                fillColor: MERGE_COLOR,
                fillOpacity: 0.35,
              }
            : hasError || unnumbered
              ? { color, weight: 2, fillColor: color, fillOpacity: 0.35 }
              : { color, weight: 1.2, fillColor: color, fillOpacity: 0.15 },
        );
      } catch {
        /* ignore */
      }
    }
  }, [
    activeMergeSelection,
    displayedSections,
    overlaps,
    pendingSectionIds,
    mapReady,
  ]);

  // ── Mise en évidence du chevauchement sélectionné (restylage seul) ─────────
  // Dépend aussi de sections/overlaps pour rejouer après chaque reconstruction
  // des couches (qui repart en style « non sélectionné »).
  useEffect(() => {
    for (const [id, layer] of overlapLayersRef.current) {
      const isSel = id === selectedOverlapId;
      try {
        layer.setStyle({
          weight: isSel ? 3 : 1.5,
          fillOpacity: isSel ? 0.7 : 0.45,
        });
      } catch {
        /* ignore */
      }
    }
  }, [selectedOverlapId, sections, overlaps, mapReady]);

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
    if (geoms.length === 0 && ov.intersectionGeoJson)
      geoms.push(ov.intersectionGeoJson);
    try {
      let bounds: any = null;
      for (const g of geoms) {
        const gb = L.geoJSON(g as any).getBounds();
        if (!gb.isValid()) continue;
        bounds = bounds ? bounds.extend(gb) : gb;
      }
      if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, {
          padding: [40, 40],
          maxZoom: 17,
          animate: true,
        });
      }
    } catch {
      /* ignore */
    }
  }, [selectedOverlapId, overlaps, sections, mapReady]);

  // ── Défilement du panneau vers le chevauchement sélectionné ────────────────
  // La réouverture du panneau se fait dans les gestionnaires de clic carte ;
  // la dépendance à panelOpen fait défiler une fois la liste montée.
  useEffect(() => {
    if (selectedOverlapId == null || !panelOpen) return;
    overlapItemRefs.current
      .get(selectedOverlapId)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedOverlapId, panelOpen]);

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
              const res = await fetch(
                `/api/cadastre/admin-boundaries?niveau=${level}`,
              );
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
          style: {
            color: style.color,
            weight: style.weight,
            dashArray: style.dashArray,
            fill: false,
          },
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
      if (b.isValid())
        map.fitBounds(b, { padding: [40, 40], maxZoom: 17, animate: true });
    } catch {
      /* ignore */
    }
  }, []);

  // ── Application d'une correction sur un chevauchement ──────────────────────
  const performCorrection = useCallback(
    async (overlapId: number, action: string) => {
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
    },
    [sourceFichier, fetchData],
  );

  /**
   * Demande de correction : « ignore » (non destructif) part directement,
   * les autres actions (découpe, fusion, suppression) passent par le dialogue
   * de confirmation avec un message propre à l'action.
   */
  const applyCorrection = useCallback(
    (o: OverlapItem, action: string) => {
      if (action === "ignore") {
        void performCorrection(o.id, "ignore");
        return;
      }
      const a = o.aNumSection ?? "A";
      const b = o.bNumSection ?? "B";
      const zone =
        o.overlapAreaM2 != null ? ` (~${Math.round(o.overlapAreaM2)} m²)` : "";
      const messages: Record<
        string,
        { title: string; description: string; confirmLabel: string }
      > = {
        clip_a: {
          title: `Découper la section ${a}`,
          description: `Retirer la zone de chevauchement${zone} de la section ${a}.\nSi elle est entièrement couverte par la section ${b}, elle sera supprimée.`,
          confirmLabel: "Découper",
        },
        clip_b: {
          title: `Découper la section ${b}`,
          description: `Retirer la zone de chevauchement${zone} de la section ${b}.\nSi elle est entièrement couverte par la section ${a}, elle sera supprimée.`,
          confirmLabel: "Découper",
        },
        merge: {
          title: `Fusionner les sections ${a} et ${b}`,
          description: `La section ${a} absorbe la section ${b}, qui sera supprimée.\nCette action est irréversible.`,
          confirmLabel: "Fusionner",
        },
        delete_a: {
          title: `Supprimer la section ${a}`,
          description: `Supprimer entièrement la section ${a} ?\nCette action est irréversible.`,
          confirmLabel: "Supprimer",
        },
        delete_b: {
          title: `Supprimer la section ${b}`,
          description: `Supprimer entièrement la section ${b} ?\nCette action est irréversible.`,
          confirmLabel: "Supprimer",
        },
      };
      const msg = messages[action];
      if (!msg) return;
      setConfirmState({
        ...msg,
        run: () => void performCorrection(o.id, action),
      });
    },
    [performCorrection],
  );

  // ── Export shapefile des sections affichées (corrections incluses) ─────────
  // Porte sur la vue courante : le lot sélectionné, ou TOUS les lots si aucun.
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const url = sourceFichier
        ? `/api/cadastre/sections/export?sourceFichier=${encodeURIComponent(sourceFichier)}`
        : "/api/cadastre/sections/export";
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Export échoué");
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const filename = cd.match(/filename="([^"]+)"/)?.[1] ?? "sections.zip";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Shapefile exporté : ${filename}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setExporting(false);
    }
  }, [sourceFichier]);

  // ── Fusion manuelle des sections sélectionnées ──────────────────────────────
  const performMerge = useCallback(async () => {
    const ids = activeMergeSelection;
    if (ids.length < 2) return;
    setMerging(true);
    try {
      const res = await fetch("/api/cadastre/sections/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fusion échouée");
      toast.success(`${ids.length} sections fusionnées.`);
      setMergeSelection([]);
      await fetchData(sourceFichier);
      void loadBatches();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setMerging(false);
    }
  }, [activeMergeSelection, sourceFichier, fetchData, loadBatches]);

  const handleMerge = useCallback(() => {
    const ids = activeMergeSelection;
    if (ids.length < 2) return;
    const first = sections.find((s) => s.id === ids[0]);
    setConfirmState({
      title: `Fusionner ${ids.length} sections`,
      description:
        `La section ${first?.numSection ?? "—"}${first?.commune ? ` (${first.commune})` : ""} — première sélectionnée — ` +
        "conserve son numéro, sa commune et son lot.\nCette action est irréversible.",
      confirmLabel: "Fusionner",
      run: () => void performMerge(),
    });
  }, [activeMergeSelection, sections, performMerge]);

  // ── Suppression du lot chargé (toutes les sections du fichier sélectionné) ─
  const performDeleteBatch = useCallback(async () => {
    if (!sourceFichier) return;
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
  }, [sourceFichier, loadBatches, fetchData]);

  const handleDeleteBatch = useCallback(() => {
    if (!sourceFichier) return;
    const batch = batches.find((b) => b.sourceFichier === sourceFichier);
    setConfirmState({
      title: "Supprimer le lot",
      description:
        `Supprimer les ${batch ? `${batch.nbSections} ` : ""}section(s) du fichier « ${sourceFichier} » ?\n` +
        "Les chevauchements associés seront aussi supprimés.\nRestaurable ensuite depuis le panneau Historique.",
      confirmLabel: "Supprimer le lot",
      run: () => void performDeleteBatch(),
    });
  }, [sourceFichier, batches, performDeleteBatch]);

  const pending = overlaps.filter((o) => o.status === "PENDING");
  // Sélection restreinte aux chevauchements encore PENDING affichés : les ids
  // résolus (correction individuelle, changement de lot) deviennent inertes
  // sans setState d'effet — même principe que `activeMergeSelection`.
  const activeOverlapSelection = overlapSelection.filter((id) =>
    pending.some((o) => o.id === id),
  );

  // ── Application groupée d'une règle sur plusieurs chevauchements ───────────
  const performBatchCorrection = useCallback(
    async (ids: number[], action: "clip_a" | "clip_b" | "auto" | "ignore") => {
      setBatchCorrecting(true);
      try {
        const res = await fetch("/api/cadastre/sections/correct-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overlapIds: ids, action, sourceFichier }),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Correction groupée échouée");
        setSections(data.sections ?? []);
        setOverlaps(data.overlaps ?? []);
        setOverlapSelection([]);
        const results: Array<{
          overlapId: number;
          ok: boolean;
          error?: string;
        }> = data.results ?? [];
        const nbOk = results.filter((r) => r.ok).length;
        const nbFail = results.length - nbOk;
        if (nbFail === 0) {
          toast.success(
            `${nbOk} correction${nbOk > 1 ? "s" : ""} appliquée${nbOk > 1 ? "s" : ""}.`,
          );
        } else {
          toast.warning(
            `${nbOk} correction${nbOk > 1 ? "s" : ""} appliquée${nbOk > 1 ? "s" : ""}, ${nbFail} échouée${nbFail > 1 ? "s" : ""}.`,
          );
          console.warn(
            "[correct-batch] échecs :",
            results.filter((r) => !r.ok),
          );
        }
      } catch (err) {
        toast.error(String(err));
      } finally {
        setBatchCorrecting(false);
      }
    },
    [sourceFichier],
  );

  const confirmBatchCorrection = useCallback(
    (action: "clip_a" | "clip_b" | "auto" | "ignore") => {
      const ids = activeOverlapSelection;
      if (ids.length === 0) return;
      const label = BATCH_ACTION_LABELS[action];
      if (action === "ignore") {
        setConfirmState({
          title: "Ignorer les chevauchements sélectionnés",
          description: `Marquer ${ids.length} chevauchement(s) comme intentionnel(s) — ils ne seront plus listés comme erreur.`,
          confirmLabel: "Ignorer",
          run: () => void performBatchCorrection(ids, action),
        });
        return;
      }
      setConfirmState({
        title: label,
        description: `${label} sur ${ids.length} chevauchement(s) sélectionné(s).\nCette action est irréversible.`,
        confirmLabel: "Appliquer",
        run: () => void performBatchCorrection(ids, action),
      });
    },
    [activeOverlapSelection, performBatchCorrection],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Carte pleine largeur — les chevauchements sont dans un panneau
          repliable superposé à la carte (bord droit). Colonne flex bornée par
          la page : contrôles à hauteur fixe, carte = espace restant. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* Barre de contrôles — deux colonnes d'encadrés arrondis :
            (import + lot stocké) à gauche, (limites admin + légende) à droite. */}
        <div className="grid gap-2 md:grid-cols-2">
          {/* Colonne 1 : import + lot stocké */}
          <div className="space-y-2">
            <div className="flex flex-col border border-border/60 rounded-xl px-2 py-1.5 gap-1.5">
              {/* Import DXF/DGN/ZIP ou Shapefile (.shp + .dbf) */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border/60 px-2 py-1">
                <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-2 text-sm hover:border-primary/50">
                  <FileUp className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate max-w-64 text-sm">
                    {files.length
                      ? files.map((f) => f.name).join(", ")
                      : "Choisir un DXF / DGN / ZIP / Shapefile"}
                  </span>
                  <input
                    type="file"
                    accept=".dxf,.dgn,.zip,.shp,.dbf,.shx,.prj"
                    multiple
                    className="hidden"
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    title="DXF/DGN/ZIP : ingestion complète. Shapefile (.shp + .dbf) : polygones déjà fermés utilisés tels quels, lignes de limites polygonisées et regroupées par numéro de section (champ du .dbf)."
                  />
                </label>
                <Button
                  size="sm"
                  onClick={handleUpload}
                  disabled={uploading || files.length === 0}
                  className="gap-1.5"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {uploading ? "Traitement…" : "Analyser les sections"}
                </Button>
              </div>

              {/* Historique des modifications (sections QA) — liste + restauration. */}
              <div className="flex items-center gap-1.5 rounded-xl border border-dashed border-border/60 px-2 py-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5"
                  onClick={() => setHistoryOpen(true)}
                >
                  <History className="h-4 w-4" />
                  Historique
                </Button>
              </div>

              {/* Lot stocké */}
              {batches.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-border/60 px-2 py-1">
                  <span className="text-xs text-muted-foreground">
                    Lot stocké :
                  </span>
                  <select
                    value={sourceFichier ?? ""}
                    onChange={(e) => void fetchData(e.target.value || null)}
                    className="h-8 max-w-55 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Choisir un lot de sections"
                  >
                    <option value="">
                      Tous les lots —{" "}
                      {batches.reduce((n, b) => n + b.nbSections, 0)} sect.
                    </option>
                    {batches.map((b) => (
                      <option key={b.sourceFichier} value={b.sourceFichier}>
                        {b.sourceFichier} — {b.nbSections} sect.
                        {b.nbOverlapsPending > 0
                          ? ` · ${b.nbOverlapsPending} chev.`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 px-2 text-xs"
                    onClick={handleExport}
                    disabled={exporting || sections.length === 0}
                    title={
                      sourceFichier
                        ? `Exporter les sections du lot « ${sourceFichier} » en shapefile (corrections incluses)`
                        : "Exporter les sections de tous les lots en shapefile (corrections incluses)"
                    }
                  >
                    {exporting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    Exporter SHP
                  </Button>
                  {sourceFichier && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 gap-1 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-400"
                      onClick={handleDeleteBatch}
                      disabled={deletingBatch}
                      title={`Supprimer toutes les sections du fichier « ${sourceFichier} »`}
                    >
                      {deletingBatch ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Supprimer le lot
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Colonne 2 : limites admin + légende */}
          <div className="space-y-2">
            <div className="flex flex-col border border-border/60 rounded-xl px-3 py-2 gap-2">
              {/* Limites administratives (contours + noms) */}
              <div className="flex items-center gap-1.5 rounded-xl border border-border/60 px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  Limites admin :
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant={
                        ADMIN_LEVELS.some((level) => adminShow[level])
                          ? "default"
                          : "outline"
                      }
                      className="h-7 gap-1.5 px-2 text-[11px]"
                    >
                      <Layers className="h-3.5 w-3.5" />
                      {ADMIN_LEVELS.filter((level) => adminShow[level]).length >
                      0
                        ? ADMIN_LEVELS.filter((level) => adminShow[level])
                            .map((level) => ADMIN_STYLES[level].label)
                            .join(", ")
                        : "Aucune"}
                      <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {ADMIN_LEVELS.map((level) => {
                      const st = ADMIN_STYLES[level];
                      return (
                        <DropdownMenuCheckboxItem
                          key={level}
                          checked={adminShow[level]}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={(checked) =>
                            setAdminShow((prev) => ({
                              ...prev,
                              [level]: checked === true,
                            }))
                          }
                        >
                          <span className="flex items-center gap-1.5">
                            <span
                              className="h-2.5 w-2.5 rounded-sm"
                              style={{ background: st.color }}
                            />
                            {st.label}
                          </span>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="sm"
                  variant={showSectionLabels ? "default" : "outline"}
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  onClick={() => setShowSectionLabels((v) => !v)}
                  title="Afficher/masquer les numéros de section sur la carte"
                >
                  <Tag className="h-3.5 w-3.5" />
                  N° sections
                </Button>
              </div>

              {/* Légende des couleurs de la carte */}
              <span className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: SECTION_OK_COLOR }}
                  />
                  Section OK
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: SECTION_ERROR_COLOR }}
                  />
                  Chevauchement à corriger
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: SECTION_UNNUMBERED_COLOR }}
                  />
                  Sans numéro
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: OVERLAP_COLOR }}
                  />
                  Zone d&apos;intersection
                </span>
              </span>
            </div>
          </div>
        </div>
        {/* Progression du job d'import */}
        {job && (job.status === "pending" || job.status === "running") && (
          <div className="rounded-xl border border-border/60 p-3 space-y-1.5">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Phase : {job.phase ?? "…"}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={handleCancelJob}>
              Annuler
            </Button>
          </div>
        )}

        <div className="relative min-h-125 flex-1">
          <div
            ref={mapEl}
            className="h-full min-h-125 w-full rounded-xl border border-border/60"
          />
          {loadingData && (
            <div className="absolute right-3 top-3 rounded-lg bg-background/90 px-3 py-1.5 text-xs shadow">
              Chargement…
            </div>
          )}
          {/* Panneau de fusion — superposé en bas à droite de la carte, là où
              se fait la sélection au clic. Sibling du conteneur Leaflet : les
              clics n'atteignent pas la carte. */}
          {activeMergeSelection.length > 0 && (
            <div className="absolute bottom-3 left-3 z-1000 w-72 rounded-xl border border-violet-400/60 bg-background/95 p-3 shadow-lg backdrop-blur">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold">
                <Combine className="h-4 w-4 text-violet-400" />
                Fusion — {activeMergeSelection.length} section
                {activeMergeSelection.length > 1 ? "s" : ""} sélectionnée
                {activeMergeSelection.length > 1 ? "s" : ""}
              </div>
              <ul className="mb-2 max-h-36 space-y-1 overflow-y-auto pr-0.5">
                {activeMergeSelection.map((id, i) => {
                  const s = sections.find((x) => x.id === id);
                  if (!s) return null;
                  return (
                    <li
                      key={id}
                      className="flex items-center gap-1.5 text-[11px]"
                    >
                      <button
                        onClick={() => zoomToSection(s)}
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        title={`Zoomer sur la section ${s.numSection ?? "—"}`}
                      >
                        {i + 1}. Section {s.numSection ?? "—"} —{" "}
                        {s.commune ?? "—"}
                      </button>
                      {i === 0 && (
                        <span
                          className="shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[9px] font-medium text-violet-400"
                          title="Première sélectionnée : conserve numéro, commune et lot"
                        >
                          garde attributs
                        </span>
                      )}
                      <button
                        onClick={() => toggleMergeSelection(id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
                        title="Retirer de la sélection"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  onClick={handleMerge}
                  disabled={merging || activeMergeSelection.length < 2}
                  title={
                    activeMergeSelection.length < 2
                      ? "Sélectionnez au moins 2 sections"
                      : "Fusionner les sections sélectionnées"
                  }
                >
                  {merging ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Combine className="h-3.5 w-3.5" />
                  )}
                  Fusionner
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => setMergeSelection([])}
                  disabled={merging}
                >
                  Annuler la sélection
                </Button>
              </div>
            </div>
          )}

          {/* Panneau latéral repliable superposé à la carte — liste des
              chevauchements + table des sections. Replié, la carte occupe
              tout l'espace. */}
          {!panelOpen && (
            <Button
              size="sm"
              variant="outline"
              className="absolute right-3 top-3 z-1000 gap-1.5 bg-background/95 shadow backdrop-blur"
              onClick={() => setPanelOpen(true)}
              aria-label="Ouvrir le panneau des chevauchements"
            >
              <ChevronsLeft className="h-4 w-4" />
              Chevauchements
              {pending.length > 0 && (
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                  {pending.length}
                </span>
              )}
            </Button>
          )}
          {panelOpen && (
            <div className="absolute bottom-3 right-3 top-3 z-1000 flex w-80 max-w-[85vw] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg backdrop-blur">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                <h3 className="text-sm font-semibold">
                  Chevauchements
                  {pending.length > 0 && (
                    <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                      {pending.length}
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {sections.length} section{sections.length > 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={() => setPanelOpen(false)}
                    aria-label="Replier le panneau des chevauchements"
                    title="Replier — la carte occupe tout l'espace"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-3">
                <div>
                  {sections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Importez un DXF pour extraire les sections et contrôler
                      les chevauchements.
                    </p>
                  ) : pending.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-green-500">
                      <CheckCircle className="h-4 w-4" /> Aucun chevauchement à
                      corriger.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={
                            pending.length > 0 &&
                            activeOverlapSelection.length === pending.length
                          }
                          ref={(el) => {
                            if (el) {
                              el.indeterminate =
                                activeOverlapSelection.length > 0 &&
                                activeOverlapSelection.length < pending.length;
                            }
                          }}
                          onChange={() =>
                            setOverlapSelection(
                              activeOverlapSelection.length === pending.length
                                ? []
                                : pending.map((o) => o.id),
                            )
                          }
                          className="h-3 w-3 cursor-pointer accent-red-500"
                        />
                        Tout sélectionner ({pending.length})
                      </label>
                      {activeOverlapSelection.length > 0 && (
                        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 rounded-lg border border-red-400/40 bg-red-500/10 p-2 shadow-sm backdrop-blur">
                          <span className="text-[11px] font-medium">
                            {activeOverlapSelection.length} sélectionné
                            {activeOverlapSelection.length > 1 ? "s" : ""}
                          </span>
                          <div className="ml-auto flex flex-wrap gap-1">
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("clip_a")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Découper A
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("clip_b")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Découper B
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("auto")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Auto (+ petite)
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("ignore")}
                              icon={<EyeOff className="h-3 w-3" />}
                            >
                              Ignorer
                            </ActBtn>
                            <button
                              onClick={() => setOverlapSelection([])}
                              disabled={batchCorrecting}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
                              title="Annuler la sélection"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="max-h-70 space-y-2 overflow-y-auto pr-0.5">
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
                                isSel
                                  ? "border-red-400/60 bg-red-500/5 ring-1 ring-red-400/30"
                                  : "border-border hover:border-red-400/30",
                              ].join(" ")}
                            >
                              <div className="mb-1.5 flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={activeOverlapSelection.includes(
                                    o.id,
                                  )}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => toggleOverlapSelection(o.id)}
                                  title="Sélectionner pour traitement groupé"
                                  className="h-3 w-3 shrink-0 cursor-pointer accent-red-500"
                                />
                                <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                                <span className="font-medium">
                                  Section {o.aNumSection ?? "—"} ↔{" "}
                                  {o.bNumSection ?? "—"}
                                </span>
                                {o.overlapAreaM2 != null && (
                                  <span className="ml-auto text-muted-foreground">
                                    {Math.round(o.overlapAreaM2)} m²
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-2 gap-1">
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  onClick={() => applyCorrection(o, "clip_a")}
                                  icon={<Scissors className="h-3 w-3" />}
                                >
                                  Découper {o.aNumSection ?? "A"}
                                </ActBtn>
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  onClick={() => applyCorrection(o, "clip_b")}
                                  icon={<Scissors className="h-3 w-3" />}
                                >
                                  Découper {o.bNumSection ?? "B"}
                                </ActBtn>
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  onClick={() => applyCorrection(o, "merge")}
                                  icon={<Combine className="h-3 w-3" />}
                                >
                                  Fusionner
                                </ActBtn>
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  onClick={() => applyCorrection(o, "ignore")}
                                  icon={<EyeOff className="h-3 w-3" />}
                                >
                                  Ignorer
                                </ActBtn>
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  danger
                                  onClick={() => applyCorrection(o, "delete_a")}
                                  icon={<Trash2 className="h-3 w-3" />}
                                >
                                  Suppr. {o.aNumSection ?? "A"}
                                </ActBtn>
                                <ActBtn
                                  busy={busy || batchCorrecting}
                                  danger
                                  onClick={() => applyCorrection(o, "delete_b")}
                                  icon={<Trash2 className="h-3 w-3" />}
                                >
                                  Suppr. {o.bNumSection ?? "B"}
                                </ActBtn>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Table des sections */}
                {sections.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        Sections ({displayedSections.length}
                        {showUnnumberedOnly ? ` / ${sections.length}` : ""})
                      </h3>
                      {/* Toujours affiché quand le filtre est actif (même à 0 restant)
                          pour que l'utilisateur puisse le désactiver ; sinon affiché
                          seulement s'il reste des sections sans numéro à filtrer. */}
                      {(unnumberedCount > 0 || showUnnumberedOnly) && (
                        <button
                          onClick={() => setShowUnnumberedOnly((v) => !v)}
                          title="Afficher uniquement les sections sans numéro"
                          className={[
                            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                            showUnnumberedOnly
                              ? "bg-amber-500/20 text-amber-500"
                              : "bg-secondary text-muted-foreground hover:bg-secondary/70",
                          ].join(" ")}
                        >
                          <Pencil className="h-3 w-3" />
                          Sans numéro ({unnumberedCount})
                        </button>
                      )}
                    </div>
                    <div className="max-h-70 overflow-auto">
                      <table className="w-full border-collapse text-[11px]">
                        <thead className="sticky top-0 bg-card">
                          <tr className="text-left text-muted-foreground">
                            <th
                              className="py-1 pr-1 font-medium"
                              title="Sélectionner pour fusion"
                              aria-label="Fusion"
                            />
                            <th className="py-1 pr-2 font-medium">Sect.</th>
                            <th className="py-1 pr-2 font-medium">Commune</th>
                            <th className="py-1 pr-2 font-medium">Dépt</th>
                            <th className="py-1 pr-2 font-medium text-right">
                              m²
                            </th>
                            <th
                              className="py-1 font-medium"
                              aria-label="Supprimer"
                            />
                          </tr>
                        </thead>
                        <tbody>
                          {displayedSections.map((s) => (
                            <tr
                              key={s.id}
                              onClick={() => zoomToSection(s)}
                              title={`Zoomer sur la section ${s.numSection ?? "—"}`}
                              className="cursor-pointer border-t border-border/40 transition-colors hover:bg-secondary/40"
                            >
                              <td className="py-1 pr-1">
                                <input
                                  type="checkbox"
                                  checked={activeMergeSelection.includes(s.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => toggleMergeSelection(s.id)}
                                  title="Sélectionner pour fusion"
                                  className="h-3 w-3 cursor-pointer accent-violet-500"
                                />
                              </td>
                              <td className="py-1 pr-2">
                                {numeroEditId === s.id ? (
                                  <span
                                    className="inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      autoFocus
                                      value={numeroDraft}
                                      onChange={(e) =>
                                        setNumeroDraft(e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          if (batchCorrecting) return;
                                          void performSetNumero(
                                            s.id,
                                            numeroDraft,
                                          );
                                        } else if (e.key === "Escape") {
                                          setNumeroEditId(null);
                                        }
                                      }}
                                      placeholder="N°"
                                      className="h-5 w-14 rounded border border-border bg-background px-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                    <button
                                      onClick={() =>
                                        void performSetNumero(s.id, numeroDraft)
                                      }
                                      disabled={
                                        savingNumero === s.id || batchCorrecting
                                      }
                                      title="Enregistrer le numéro"
                                      className="rounded p-0.5 text-green-500 transition-colors hover:bg-green-500/10 disabled:opacity-40"
                                    >
                                      {savingNumero === s.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <Check className="h-3 w-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={() => setNumeroEditId(null)}
                                      title="Annuler"
                                      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span
                                      className="h-2.5 w-2.5 rounded-sm"
                                      style={{
                                        background: sectionColor(
                                          pendingSectionIds.has(s.id),
                                          !s.numSection,
                                        ),
                                      }}
                                    />
                                    {s.numSection ? (
                                      <span className="inline-flex items-center gap-1">
                                        {s.numSection}
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setNumeroEditId(s.id);
                                            setNumeroDraft(s.numSection ?? "");
                                          }}
                                          disabled={batchCorrecting}
                                          title="Modifier le numéro de section (recalcule les NICAD rattachés)"
                                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setNumeroEditId(s.id);
                                          setNumeroDraft("");
                                        }}
                                        disabled={batchCorrecting}
                                        title="Attribuer un numéro de section"
                                        className="inline-flex items-center gap-1 text-amber-500 hover:underline disabled:opacity-40"
                                      >
                                        <Pencil className="h-3 w-3" />—
                                      </button>
                                    )}
                                  </span>
                                )}
                              </td>
                              <td className="py-1 pr-2 truncate max-w-27.5">
                                {s.commune ?? "—"}
                              </td>
                              <td className="py-1 pr-2 truncate max-w-22.5">
                                {s.departement ?? "—"}
                              </td>
                              <td className="py-1 pr-2 text-right font-mono">
                                {s.surfaceM2 != null
                                  ? Math.round(s.surfaceM2).toLocaleString(
                                      "fr-FR",
                                    )
                                  : "—"}
                              </td>
                              <td className="py-1 text-right">
                                {s.numSection && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleFillMissingNicad(s);
                                    }}
                                    disabled={
                                      fillingNicadId === s.id ||
                                      batchCorrecting
                                    }
                                    title="Attribuer les NICAD manquants (plus proche voisin)"
                                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-blue-500/10 hover:text-blue-400 disabled:opacity-40"
                                  >
                                    {fillingNicadId === s.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <ListOrdered className="h-3 w-3" />
                                    )}
                                  </button>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteSection(s);
                                  }}
                                  disabled={
                                    deletingSectionId === s.id ||
                                    batchCorrecting
                                  }
                                  title={`Supprimer la section ${s.numSection ?? "—"}`}
                                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                                >
                                  {deletingSectionId === s.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-3 w-3" />
                                  )}
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
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ""}
        description={confirmState?.description ?? ""}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={() => {
          confirmState?.run();
          setConfirmState(null);
        }}
        onCancel={() => setConfirmState(null)}
      />

      <CadHistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        scope="sections"
        scopeKey={null}
        onRestored={() => void fetchData(sourceFichier)}
      />

      {pendingShapefileInventory && (
        <FieldMappingModal
          fileName={pendingShapefileInventory.fileName}
          targetFields={pendingShapefileInventory.targetFields}
          availableFields={pendingShapefileInventory.fields}
          proposedMapping={pendingShapefileInventory.proposedMapping}
          onCancel={() => setPendingShapefileInventory(null)}
          onConfirm={(mapping) => void startShapefileSectionsJob(mapping)}
        />
      )}
    </div>
  );
}

function ActBtn({
  children,
  onClick,
  icon,
  busy,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon: React.ReactNode;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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
