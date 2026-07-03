"use client";
import { useState, useCallback, useMemo, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CheckCircle, Brain, FileText,
  Download, Wrench, ChevronRight, MapPin, X, Trash2, Table2,
  ChevronDown, ChevronUp, RefreshCw, Copy, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NavBar } from "@/components/NavBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { toNum, errorTypeColor } from "@/lib/utils";

const MapLibreMap = dynamic(() => import("@/components/MapLibreMap"), { ssr: false });

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

interface Analysis {
  id: number;
  fileName: string;
  fileFormat: string;
  status: string;
  totalFeatures: number | null;
  errorCount: number | null;
  outOfSenegalCount?: number;
  conformeCount: number | null;
  conformityScore: number;
  commune: string | null;
  region: string | null;
  crs: string | null;
  aiReport: string | null;
  correctedData: string | null;
  createdAt: string;
  errors: GeoError[];
  /** Liste d'erreurs tronquée (le total dépasse le plafond de rendu). */
  errorsTruncated?: boolean;
}

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  analysis: Analysis;
}

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// Réplique du critère moteur (geo-engine.isMissingNicadValue + longueur < 8) pour
// le calcul de repli des parcelles conformes côté client.
const MISSING_NICAD_VALUES = new Set([
  "", "null", "undefined", "na", "n/a", "néant", "neant", "aucun", "sans nicad", "0", "-",
]);
function isNicadProblematic(nicad: string): boolean {
  const v = nicad.trim().toLowerCase();
  if (MISSING_NICAD_VALUES.has(v)) return true;
  return nicad.trim().length < 8;
}

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Critique", HIGH: "Élevé", MEDIUM: "Moyen", LOW: "Faible",
};

function AttributeTable({
  rows,
  selectable = false,
  selectedKeys,
  onToggle,
}: {
  rows: Record<string, unknown>[];
  /** Affiche une colonne de cases à cocher (parcelles supprimables, clé = index de ligne). */
  selectable?: boolean;
  /** Index (dans `rows`) des lignes cochées. */
  selectedKeys?: Set<number>;
  onToggle?: (index: number) => void;
}) {
  const allKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cols = [
    ...allKeys.filter((k) => k === "_role"),
    ...allKeys.filter((k) => !k.startsWith("_")),
  ];
  const isDiff = (col: string) =>
    rows.length === 2 && String(rows[0][col] ?? "") !== String(rows[1][col] ?? "");

  return (
    <table className="text-[11px] w-full border-collapse">
      <thead className="sticky top-0 bg-card z-10">
        <tr>
          {selectable && (
            <th className="px-2 py-1.5 border-b border-border bg-card w-8" />
          )}
          {cols.map((col) => (
            <th
              key={col}
              className="px-2.5 py-1.5 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap bg-card"
            >
              {col === "_role" ? "Rôle" : col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          return (
            <tr key={i} className={i % 2 === 0 ? "" : "bg-secondary/20"}>
              {selectable && (
                <td className="px-2 py-1 border-b border-border/40 text-center">
                  <input
                    type="checkbox"
                    className="cursor-pointer accent-red-500"
                    checked={selectedKeys?.has(i) ?? false}
                    onChange={() => onToggle?.(i)}
                    title="Sélectionner pour suppression"
                  />
                </td>
              )}
              {cols.map((col) => (
                <td
                  key={col}
                  className={[
                    "px-2.5 py-1 border-b border-border/40 whitespace-nowrap",
                    col === "_role" ? "font-medium text-primary" : "font-mono",
                    isDiff(col) ? "bg-yellow-500/15 text-yellow-300 font-semibold" : "",
                  ].join(" ")}
                >
                  {String(row[col] ?? "")}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function MapAnalysisClient({ user, analysis }: Props) {
  const router = useRouter();
  const [selectedError, setSelectedError] = useState<GeoError | null>(null);
  const [selectedDupNicad, setSelectedDupNicad] = useState<string | null>(null);
  // Lignes cochées (index dans `tableRows`) pour suppression de parcelles.
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [deletingRows, setDeletingRows] = useState(false);
  const [selectedParcel, setSelectedParcel] = useState<Record<string, unknown> | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [correctedData, setCorrectedData] = useState<string | null>(analysis.correctedData);
  // Tier 2 : GeoJSON récupéré via API et parsé une seule fois (objet partagé
  // entre la carte, la table attributaire et la recherche NICAD).
  const [displayFc, setDisplayFc] = useState<GeoJSON.FeatureCollection | null>(null);
  // Jeu volumineux : pas de chargement du FC complet → pas d'état « en cours ».
  const [geoLoading, setGeoLoading] = useState(() => (analysis.totalFeatures ?? 0) <= 20000);
  const [showConforme, setShowConforme] = useState(false);
  const [isSavingReport, setIsSavingReport] = useState(false);
  const [isRegeneratingReport, setIsRegeneratingReport] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(analysis.aiReport);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([]);
  const [tableOpen, setTableOpen] = useState(false);
  const [nicadSearch, setNicadSearch] = useState("");
  const [focusTarget, setFocusTarget] = useState<{ nicad: string; key: number } | null>(null);
  const [searchedNicad, setSearchedNicad] = useState<string | null>(null);
  const [correctingErrorId, setCorrectingErrorId] = useState<number | null>(null);
  const [correctedErrorIds, setCorrectedErrorIds] = useState<Set<number>>(new Set());
  const [nicadAssignValue, setNicadAssignValue] = useState("");
  // Rendu par tuiles vectorielles (MVT) : emprise globale pour le fit initial,
  // et version incrémentée à chaque correction pour invalider le cache des tuiles.
  const [initialBounds, setInitialBounds] = useState<[number, number, number, number] | null>(null);
  const [tileVersion, setTileVersion] = useState(0);

  // Au-delà de ce seuil, on ne charge PAS tout le GeoJSON côté client (OOM
  // navigateur) : la carte s'appuie sur les tuiles vectorielles, et les panneaux
  // détaillés (table complète, recherche locale) sont dérivés à la demande.
  const LARGE_DATASET = (analysis.totalFeatures ?? 0) > 20000;

  const sortedErrors = useMemo(
    () => [...analysis.errors].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4)),
    [analysis.errors]
  );

  const filteredErrors = useMemo(
    () => activeFilters.size > 0 ? sortedErrors.filter((e) => activeFilters.has(e.errorType)) : sortedErrors,
    [sortedErrors, activeFilters]
  );

  const errorTypeGroups = useMemo(
    () => Array.from(new Set(analysis.errors.map((e) => e.errorType))),
    [analysis.errors]
  );

  // NICAD distincts impliqués dans au moins une erreur (= parcelles non conformes).
  const nonConformeNicads = useMemo(() => {
    const s = new Set<string>();
    for (const e of analysis.errors) {
      if (e.nicad1) s.add(e.nicad1);
      if (e.nicad2) s.add(e.nicad2);
    }
    return Array.from(s);
  }, [analysis.errors]);

  // Parcelles conformes : valeur autoritative calculée à l'analyse (comptage des
  // parcelles distinctes en erreur, fiable même sans NICAD). Pour les analyses
  // antérieures (valeur absente), repli calculé sur les features chargées.
  const conformeCount = useMemo<number | null>(() => {
    if (analysis.conformeCount != null) return analysis.conformeCount;
    if (!displayFc) return null; // en attente du GeoJSON
    const errSet = new Set(nonConformeNicads);
    let nonConforme = 0;
    for (const feat of displayFc.features) {
      const p = (feat.properties ?? {}) as Record<string, unknown>;
      const nicad = String(p.NICAD ?? p.nicad ?? p.NIC ?? p.Nicad ?? "").trim();
      if (isNicadProblematic(nicad) || errSet.has(nicad)) nonConforme++;
    }
    return Math.max(0, displayFc.features.length - nonConforme);
  }, [analysis.conformeCount, displayFc, nonConformeNicads]);

  // Emprise globale pour le fit initial de la carte (rendu par tuiles) : servie
  // par map-meta, indépendante du chargement du GeoJSON complet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/map-meta`);
        if (!res.ok) return;
        const meta = (await res.json()) as { bbox: [number, number, number, number] | null };
        if (!cancelled) setInitialBounds(meta.bbox);
      } catch {
        /* le fit initial est optionnel */
      }
    })();
    return () => { cancelled = true; };
  }, [analysis.id, tileVersion]);

  // Avertit quand la liste d'erreurs est tronquée (jeu très volumineux) : le
  // compteur total reste exact, mais carte et liste n'en montrent qu'un sous-ensemble.
  useEffect(() => {
    if (analysis.errorsTruncated) {
      toast.info("Affichage des erreurs limité", {
        description: `${analysis.errorCount?.toLocaleString("fr-FR")} erreurs au total — seules les ${analysis.errors.length.toLocaleString("fr-FR")} plus prioritaires sont affichées.`,
      });
    }
    // Au montage uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Charge le GeoJSON complet pour les panneaux détaillés (table, recherche
  // locale, comptage de repli). Ignoré pour les jeux volumineux : la carte
  // s'appuie alors sur les tuiles, sans saturer la mémoire du navigateur.
  useEffect(() => {
    // Jeu volumineux : displayFc reste null (init), la carte s'appuie sur les
    // tuiles — on ne touche pas à l'état ici (pas de setState synchrone).
    if (LARGE_DATASET) return;
    let cancelled = false;
    async function load() {
      setGeoLoading(true);
      try {
        if (correctedData) {
          const fc = JSON.parse(correctedData) as GeoJSON.FeatureCollection;
          if (!cancelled) setDisplayFc(fc);
          return;
        }
        const res = await fetch(`/api/analyses/${analysis.id}/geojson`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fc = (await res.json()) as GeoJSON.FeatureCollection;
        if (!cancelled) setDisplayFc(fc);
      } catch (err) {
        console.error("[MapAnalysisClient] Chargement GeoJSON:", err);
        if (!cancelled) {
          toast.error("Erreur de chargement des données géographiques");
          setDisplayFc({ type: "FeatureCollection", features: [] });
        }
      } finally {
        if (!cancelled) setGeoLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [analysis.id, correctedData, LARGE_DATASET]);

  // Lookup map: NICAD → first feature properties
  const nicadToProps = useMemo<Map<string, Record<string, unknown>>>(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const feat of displayFc?.features ?? []) {
      const p = (feat.properties ?? {}) as Record<string, unknown>;
      const nicad = String(p.NICAD ?? p.nicad ?? p.NIC ?? p.Nicad ?? "");
      if (nicad) m.set(nicad, p);
    }
    return m;
  }, [displayFc]);

  // Lookup map: NICAD → ALL features (needed for duplicate group comparison)
  const nicadToAllFeatures = useMemo<Map<string, Record<string, unknown>[]>>(() => {
    const m = new Map<string, Record<string, unknown>[]>();
    for (const feat of displayFc?.features ?? []) {
      const p = (feat.properties ?? {}) as Record<string, unknown>;
      const nicad = String(p.NICAD ?? p.nicad ?? p.NIC ?? p.Nicad ?? "");
      if (nicad) {
        if (!m.has(nicad)) m.set(nicad, []);
        m.get(nicad)!.push(p);
      }
    }
    return m;
  }, [displayFc]);

  // Duplicate groups: one entry per unique NICAD with multiple occurrences.
  // (errorType est stocké en MAJUSCULES côté DB — comparaison insensible à la casse.)
  const duplicateGroups = useMemo(() => {
    const grouped = new Map<string, { errors: GeoError[]; objectIds: string[] }>();
    for (const e of analysis.errors) {
      if (e.errorType?.toUpperCase() !== "DUPLICATE" || !e.nicad1) continue;
      if (!grouped.has(e.nicad1)) grouped.set(e.nicad1, { errors: [], objectIds: [] });
      grouped.get(e.nicad1)!.errors.push(e);
      if (e.nicad2) grouped.get(e.nicad1)!.objectIds.push(e.nicad2);
    }
    return Array.from(grouped.entries()).map(([nicad, { errors, objectIds }]) => ({
      nicad,
      errors,
      objectIds,
      count: errors.length,
    }));
  }, [analysis.errors]);

  // NICAD dupliqués (lookup O(1)) pour déclencher l'affichage du groupe au clic.
  const duplicateNicadSet = useMemo(
    () => new Set(duplicateGroups.map((g) => g.nicad)),
    [duplicateGroups]
  );

  // Récupère toutes les parcelles d'un même NICAD : cache local (petits jeux) ou
  // endpoint serveur (gros jeux, `displayFc` non chargé).
  const fetchNicadGroup = useCallback(
    async (nicad: string): Promise<Record<string, unknown>[]> => {
      const local = nicadToAllFeatures.get(nicad);
      if (local && local.length) return local;
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/nicad-group?nicad=${encodeURIComponent(nicad)}`);
        if (!res.ok) return [];
        const data = (await res.json()) as { members: Record<string, unknown>[] };
        return data.members ?? [];
      } catch {
        return [];
      }
    },
    [analysis.id, nicadToAllFeatures]
  );

  const handleFeatureClick = useCallback((props: Record<string, unknown>, point?: { lng: number; lat: number }) => {
    setSelectedParcel(props);
    setSearchedNicad(null);
    const clean = Object.fromEntries(Object.entries(props).filter(([k]) => !k.startsWith("_")));
    // Point intérieur (clic carte) conservé comme localisateur fiable pour la
    // suppression de cette parcelle depuis la table attributaire.
    if (point) clean._point = [point.lng, point.lat];
    const nicad = String(clean.NICAD ?? clean.nicad ?? clean.NIC ?? clean.Nicad ?? "");
    // Pont carte → panneau de correction : si la parcelle cliquée est impliquée
    // dans une erreur non corrigée, on la sélectionne pour ouvrir les actions.
    if (nicad) {
      const match = analysis.errors.find(
        (e) => !e.corrected && !correctedErrorIds.has(e.id) && (e.nicad1 === nicad || e.nicad2 === nicad)
      );
      if (match) setSelectedError(match);

      // Parcelle à NICAD dupliqué : afficher TOUTES les occurrences de ce NICAD
      // dans la table attributaire (récupérées côté serveur si nécessaire). Le
      // clignotement s'intensifie automatiquement (selectedError = DUPLICATE).
      if (duplicateNicadSet.has(nicad)) {
        setSelectedDupNicad(nicad);
        setSelectedRows(new Set());
        setTableOpen(true);
        void fetchNicadGroup(nicad).then((members) => {
          if (members.length > 1) {
            setTableRows(members.map((p, i) => ({ _role: `Occurrence ${i + 1}`, ...p })));
          }
        });
        return;
      }
    }

    setSelectedDupNicad(null);
    setTableRows((prev) => {
      const idx = prev.findIndex(
        (r) => String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? "") === nicad && nicad !== ""
      );
      const next = idx >= 0 ? prev.filter((_, i) => i !== idx) : [...prev, clean];
      return next.map((r, i) => ({ ...r, _role: next.length === 1 ? "Sélectionné" : `P${i + 1}` }));
    });
    setTableOpen(true);
  }, [analysis.errors, correctedErrorIds, duplicateNicadSet, fetchNicadGroup]);

  // Select a duplicate group → highlight all occurrences + populate comparison table
  const selectDuplicateGroup = useCallback(
    (group: { nicad: string; errors: GeoError[]; objectIds: string[] }) => {
      setSearchedNicad(null);
      setSelectedDupNicad(group.nicad);
      setSelectedError(group.errors[0] ?? null); // fit map to first occurrence + blink intense
      setTableOpen(true);
      setSelectedRows(new Set());
      void fetchNicadGroup(group.nicad).then((members) => {
        if (members.length > 0) {
          setTableRows(members.map((p, i) => ({ _role: `Occurrence ${i + 1}`, ...p })));
        }
      });
    },
    [fetchNicadGroup]
  );

  const toggleRow = useCallback((index: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Supprime les parcelles cochées de la table attributaire. Chaque ligne est
  // localisée de façon fiable : point intérieur (clic carte), emprise
  // (occurrence d'un groupe NICAD) ou NICAD (repli). L'édition est écrite dans
  // `correctedData` côté serveur ; les erreurs de topologie rattachées
  // (`_errorId`) sont marquées corrigées. Action irréversible → confirmation.
  const handleDeleteSelectedParcels = useCallback(async () => {
    const indices = Array.from(selectedRows).sort((a, b) => a - b);
    const rows = indices.map((i) => tableRows[i]).filter(Boolean);
    if (rows.length === 0) return;
    if (
      !window.confirm(
        `Supprimer ${rows.length} parcelle${rows.length > 1 ? "s" : ""} ? ` +
          "Cette action modifie les données de l'analyse et est irréversible."
      )
    ) {
      return;
    }

    const locators = rows.map((r) => ({
      point: Array.isArray(r._point) ? (r._point as [number, number]) : undefined,
      bbox:
        Array.isArray(r._bbox) && r._bbox.length === 4
          ? (r._bbox as [number, number, number, number])
          : undefined,
      nicad: String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? "").trim() || undefined,
    }));
    const errorIds = rows
      .map((r) => (typeof r._errorId === "number" ? r._errorId : null))
      .filter((x): x is number => x !== null);

    setDeletingRows(true);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/features/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locators, errorIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Suppression échouée");
      if (data.correctedGeoJson) setCorrectedData(data.correctedGeoJson);
      setTileVersion((v) => v + 1); // rafraîchit les tuiles (parcelles retirées)
      for (const eid of errorIds) setCorrectedErrorIds((prev) => new Set(prev).add(eid));
      const removeSet = new Set(indices);
      setTableRows((prev) => {
        const next = prev.filter((_, i) => !removeSet.has(i));
        return next.map((r, i) => ({
          ...r,
          _role: String(r._role ?? "").startsWith("Occurrence")
            ? `Occurrence ${i + 1}`
            : next.length === 1
              ? "Sélectionné"
              : `P${i + 1}`,
        }));
      });
      setSelectedRows(new Set());
      toast.success(`${data.deleted} parcelle(s) supprimée(s)`);
      if (data.notFound > 0) toast.warning(`${data.notFound} parcelle(s) non localisée(s) — ignorée(s)`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeletingRows(false);
    }
  }, [selectedRows, tableRows, analysis.id]);

  // NiCADs of all selected table rows (drives map highlight)
  const selectedNicads = useMemo(
    () =>
      tableRows
        .map((r) => String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? ""))
        .filter(Boolean),
    [tableRows]
  );

  // La table attributaire est éditable dès qu'elle contient des parcelles.
  const tableDeletable = tableRows.length > 0;

  // Populate table when an error is selected
  useEffect(() => {
    if (!selectedError) return;
    // Les doublons sont gérés à part (groupe complet via fetchNicadGroup) : ne pas
    // écraser la table avec la seule Parcelle 1/2 de l'erreur.
    if (selectedError.errorType?.toUpperCase() === "DUPLICATE") return;
    const rows: Record<string, unknown>[] = [];
    if (selectedError.nicad1) {
      const p = nicadToProps.get(selectedError.nicad1);
      if (p) rows.push({ _role: "Parcelle 1", ...p });
    }
    if (selectedError.nicad2) {
      const p = nicadToProps.get(selectedError.nicad2);
      if (p) rows.push({ _role: "Parcelle 2", ...p });
    }
    if (rows.length > 0) { setTableRows(rows); setTableOpen(true); }
  }, [selectedError, nicadToProps]);

  const handleSearchNicad = useCallback(() => {
    const query = nicadSearch.trim();
    if (!query) return;
    const feats = nicadToAllFeatures.get(query);
    if (!feats || feats.length === 0) {
      // Jeu volumineux : le FC complet n'est pas chargé côté client. On recentre
      // et surligne la parcelle via les tuiles (le fit résout l'emprise serveur) ;
      // la table détaillée n'est pas peuplée faute de données locales.
      if (LARGE_DATASET) {
        setSelectedError(null);
        setSelectedDupNicad(null);
        setFocusTarget({ nicad: query, key: Date.now() });
        setSearchedNicad(query);
        return;
      }
      toast.error("NICAD introuvable", { description: `Aucune parcelle trouvée pour "${query}"` });
      return;
    }
    setSelectedError(null);
    setSelectedDupNicad(null);
    setSelectedParcel(feats[0]);
    setTableRows(
      feats.map((p, i) => ({
        _role: feats.length > 1 ? `Occurrence ${i + 1}` : "Résultat",
        ...p,
      }))
    );
    setTableOpen(true);
    setFocusTarget({ nicad: query, key: Date.now() });
    setSearchedNicad(query);
  }, [nicadSearch, nicadToAllFeatures, LARGE_DATASET]);

  const handleResetSearch = useCallback(() => {
    setNicadSearch("");
    setSelectedParcel(null);
    setSelectedError(null);
    setSelectedDupNicad(null);
    setTableRows([]);
    setFocusTarget(null);
    setSearchedNicad(null);
  }, []);

  const toggleFilter = (type: string) => {
    const next = new Set(activeFilters);
    if (next.has(type)) next.delete(type); else next.add(type);
    setActiveFilters(next);
  };

  const handleChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatLoading(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          analysisId: analysis.id,
          parcelleContext: selectedParcel ? {
            nicad: selectedParcel.NICAD || selectedParcel.nicad,
            properties: selectedParcel,
          } : undefined,
          conversationHistory: chatMessages,
        }),
      });
      const data = await res.json();
      setChatMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
    } catch (err) {
      toast.error("Erreur IA", { description: String(err) });
    } finally {
      setChatLoading(false);
    }
  };

  const handleCorrectError = useCallback(
    async (errorId: number, action: string, targetNicad?: string) => {
      setCorrectingErrorId(errorId);
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/errors/${errorId}/correct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, targetNicad }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erreur lors de la correction");
        if (data.correctedGeoJson) setCorrectedData(data.correctedGeoJson);
        // Invalide le cache des tuiles vectorielles (la carte reflète la correction).
        setTileVersion((v) => v + 1);
        setCorrectedErrorIds((prev) => new Set(prev).add(errorId));
        toast.success("Correction appliquée", { description: data.message });
        setSelectedError(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setCorrectingErrorId(null);
      }
    },
    [analysis.id]
  );

  const handleSaveReport = async () => {
    setIsSavingReport(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId: analysis.id, reportType: "DETAILED" }),
      });
      if (!res.ok) throw new Error("Erreur lors de la sauvegarde");
      toast.success("Rapport sauvegardé", { description: "Consultez la page Rapports pour le télécharger." });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsSavingReport(false);
    }
  };

  const handleRegenerateReport = async () => {
    setIsRegeneratingReport(true);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/regenerate-report`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur lors de la génération");
      setAiReport(data.aiReport);
      toast.success("Rapport régénéré avec succès");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsRegeneratingReport(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur lors de la suppression");
      toast.success("Analyse supprimée", {
        description: `${data.deleted.fileName} — ${data.deleted.errors} erreurs, ${data.deleted.reports} rapport(s) supprimés`,
      });
      router.push("/history");
    } catch (err) {
      toast.error(String(err));
      setIsDeleting(false);
    }
  };

  const handleDownloadCorrected = () => {
    if (!correctedData) { toast.error("Aucune correction disponible"); return; }
    const blob = new Blob([correctedData], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${analysis.fileName}_corrected.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <NavBar user={user} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <div className="w-96 border-r border-border flex flex-col bg-card shrink-0">
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold truncate">{analysis.fileName}</h2>
              <Badge variant={analysis.conformityScore >= 70 ? "default" : "destructive"} className="text-xs shrink-0 ml-2">
                {toNum(analysis.conformityScore).toFixed(0)}%
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{(analysis.totalFeatures ?? 0).toLocaleString()} parcelles</span>
              <span>·</span>
              <span className="text-green-400" title="Parcelles sans erreur topologique">
                {conformeCount != null ? conformeCount.toLocaleString() : "…"} conformes
              </span>
              <span>·</span>
              <span className="text-red-400">{analysis.errorCount ?? 0} erreurs</span>
              {(analysis.outOfSenegalCount ?? 0) > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-400" title="Entités hors des limites du Sénégal, écartées de l'affichage">
                    {analysis.outOfSenegalCount} hors Sénégal
                  </span>
                </>
              )}
              {(analysis.commune || analysis.region) && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {[analysis.commune, analysis.region].filter(Boolean).join(", ")}
                  </span>
                </>
              )}
            </div>

            {/* NICAD search */}
            <div className="flex gap-2 mt-3">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={nicadSearch}
                  onChange={(e) => setNicadSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSearchNicad(); } }}
                  placeholder="Rechercher par NICAD…"
                  className="w-full text-xs pl-8 pr-7 py-1.5 rounded-md border border-border bg-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {nicadSearch && (
                  <button
                    onClick={handleResetSearch}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    title="Réinitialiser la recherche"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={handleSearchNicad} disabled={!nicadSearch.trim()}>
                Chercher
              </Button>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                variant={showConforme ? "default" : "outline"}
                className="gap-1.5 flex-1 h-8 text-xs"
                onClick={() => setShowConforme((v) => !v)}
                title="Mettre en évidence les parcelles conformes sur la carte"
              >
                <CheckCircle className="w-3 h-3" />
                {showConforme ? "Conformes affichées" : "Conformes"}
              </Button>
              {correctedData && (
                <Button size="sm" variant="outline" className="gap-1.5 flex-1 h-8 text-xs" onClick={handleDownloadCorrected}>
                  <Download className="w-3 h-3" /> Télécharger
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                onClick={() => setShowDeleteModal(true)}
                title="Supprimer l'analyse"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          <Tabs defaultValue="errors" className="flex-1 flex flex-col overflow-hidden">
            <div className="mx-4 mt-3 shrink-0 flex items-center gap-2">
              <TabsList className="flex-1 grid grid-cols-4">
                <TabsTrigger value="errors" className="text-xs px-1">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  Erreurs
                </TabsTrigger>
                <TabsTrigger value="duplicates" className="text-xs px-1 relative">
                  <Copy className="w-3 h-3 mr-1" />
                  Doublons
                  {duplicateGroups.length > 0 && (
                    <span className="ml-1 text-[9px] font-bold bg-purple-500/30 text-purple-300 rounded px-1 py-0">
                      {duplicateGroups.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="report" className="text-xs px-1">
                  <FileText className="w-3 h-3 mr-1" />
                  Rapport
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs px-1">
                  <Brain className="w-3 h-3 mr-1" />
                  IA
                </TabsTrigger>
              </TabsList>
              <Link href={`/map/${analysis.id}/table`} title="Voir les données en table">
                <Button size="icon" variant="outline" className="h-8 w-8 shrink-0">
                  <Table2 className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>

            {/* Errors tab */}
            <TabsContent value="errors" className="flex-1 overflow-hidden flex flex-col px-4 mt-3">
              {/* Type filters */}
              <div className="flex flex-wrap gap-1 mb-3">
                {errorTypeGroups.map((type) => {
                  const count = analysis.errors.filter((e) => e.errorType === type).length;
                  const active = activeFilters.has(type);
                  return (
                    <button
                      key={type}
                      onClick={() => toggleFilter(type)}
                      className={`cursor-pointer text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full inline-block mr-1" style={{ background: errorTypeColor(type) }} />
                      {type} ({count})
                    </button>
                  );
                })}
              </div>

              {filteredErrors.length > 0 && (
                <p className="text-[11px] text-muted-foreground mb-2 leading-relaxed">
                  👉 Cliquez sur une erreur ci-dessous (ou sur une parcelle de la carte) pour la
                  localiser, puis choisissez une action de correction dans le panneau qui s&apos;ouvre en bas.
                </p>
              )}
              <ScrollArea className="flex-1">
                <div className="space-y-1.5 pb-4">
                  {filteredErrors.map((err) => (
                    <button
                      key={err.id}
                      onClick={() => {
                        setSelectedDupNicad(null);
                        setSelectedError(selectedError?.id === err.id ? null : err);
                      }}
                      className={`cursor-pointer w-full text-left p-3 rounded-lg border transition-all ${
                        selectedError?.id === err.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                      } ${err.corrected || correctedErrorIds.has(err.id) ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: errorTypeColor(err.errorType) }} />
                        <span className="text-[10px] font-mono">{err.errorType}</span>
                        <Badge
                          variant={err.severity.toLowerCase() as "critical" | "high" | "medium" | "low"}
                          className="text-[9px] h-4 px-1 ml-auto"
                        >
                          {SEVERITY_LABELS[err.severity] || err.severity}
                        </Badge>
                      </div>
                      {err.nicad1 && (
                        <p className="text-xs font-mono text-muted-foreground truncate">
                          {err.nicad1}{err.nicad2 ? ` ↔ ${err.nicad2}` : ""}
                        </p>
                      )}
                      {err.area && (
                        <p className="text-[10px] text-muted-foreground">{err.area.toFixed(2)} m²</p>
                      )}
                    </button>
                  ))}
                  {filteredErrors.length === 0 && (
                    <div className="text-center py-8">
                      <CheckCircle className="w-8 h-8 text-green-400 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">Aucune erreur</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Duplicates tab */}
            <TabsContent value="duplicates" className="flex-1 overflow-hidden flex flex-col px-4 mt-3">
              {duplicateGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-2">
                  <CheckCircle className="w-8 h-8 text-green-400 opacity-70" />
                  <p className="text-sm text-muted-foreground">Aucun doublon détecté</p>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground mb-3 shrink-0">
                    <span className="font-semibold text-purple-400">{duplicateGroups.length}</span> NICAD
                    {duplicateGroups.length > 1 ? "s" : ""} dupliqué{duplicateGroups.length > 1 ? "s" : ""}
                    {" · "}cliquer un groupe pour le mettre en évidence sur la carte
                  </p>
                  <ScrollArea className="flex-1">
                    <div className="space-y-2 pb-4">
                      {duplicateGroups.map((group) => {
                        const isSelected = selectedDupNicad === group.nicad;
                        return (
                          <button
                            key={group.nicad}
                            onClick={() => selectDuplicateGroup(group)}
                            className={[
                              "cursor-pointer w-full text-left p-3 rounded-lg border transition-all",
                              isSelected
                                ? "border-purple-400/60 bg-purple-500/10 ring-1 ring-purple-400/30"
                                : "border-border hover:border-purple-400/30 hover:bg-purple-500/5",
                            ].join(" ")}
                          >
                            {/* Header row */}
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
                              <span className="text-xs font-mono flex-1 truncate font-semibold">
                                {group.nicad}
                              </span>
                              <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/30 text-[9px] h-4 px-1.5">
                                {group.count}×
                              </Badge>
                            </div>

                            {/* Occurrence list */}
                            <div className="space-y-1 pl-4">
                              {group.errors.map((err, i) => (
                                <div key={err.id} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                  <span className="font-mono text-purple-400/70">#{i + 1}</span>
                                  <span className="font-mono">
                                    OBJECTID&nbsp;{err.nicad2 ?? "—"}
                                  </span>
                                  {err.area != null && err.area > 0 && (
                                    <span className="ml-auto text-muted-foreground/60">
                                      {err.area.toFixed(0)} m²
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>

                            {isSelected && (
                              <p className="text-[9px] text-purple-400/70 mt-2 pl-4">
                                ✓ Occurrences surlignées sur la carte · Comparaison ouverte
                              </p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </>
              )}
            </TabsContent>

            {/* Report tab */}
            <TabsContent value="report" className="flex-1 overflow-hidden flex flex-col px-4 mt-3">
              <div className="flex gap-2 mb-3 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-7 text-xs"
                  onClick={handleRegenerateReport}
                  disabled={isRegeneratingReport}
                  title="Régénérer le rapport IA"
                >
                  <RefreshCw className={`w-3 h-3 ${isRegeneratingReport ? "animate-spin" : ""}`} />
                  {isRegeneratingReport ? "Génération..." : "Régénérer"}
                </Button>
                {aiReport && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-7 text-xs flex-1"
                      onClick={handleSaveReport}
                      disabled={isSavingReport}
                    >
                      <Download className="w-3 h-3" />
                      {isSavingReport ? "Sauvegarde..." : "Sauvegarder"}
                    </Button>
                    <Link href="/reports">
                      <Button size="sm" variant="ghost" className="h-7 text-xs gap-1">
                        <FileText className="w-3 h-3" /> Voir tous
                      </Button>
                    </Link>
                  </>
                )}
              </div>
              <ScrollArea className="flex-1 pb-4">
                {isRegeneratingReport ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <RefreshCw className="w-6 h-6 text-primary animate-spin" />
                    <p className="text-xs text-muted-foreground">Génération du rapport en cours…</p>
                  </div>
                ) : aiReport ? (
                  <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed">
                    <ReactMarkdown>{aiReport}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                    <p className="text-sm text-muted-foreground">Rapport non disponible</p>
                    <p className="text-xs text-muted-foreground mt-1">Cliquez sur &quot;Régénérer&quot; pour créer un rapport IA</p>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* Chat tab */}
            <TabsContent value="chat" className="flex-1 flex flex-col overflow-hidden px-4 mt-3">
              <ScrollArea className="flex-1 mb-3">
                <div className="space-y-3 pb-2">
                  {chatMessages.length === 0 && (
                    <div className="text-center py-6">
                      <Brain className="w-8 h-8 text-primary mx-auto mb-2 opacity-50" />
                      <p className="text-xs text-muted-foreground">Posez une question sur vos données cadastrales</p>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] px-3 py-2 rounded-lg text-xs ${
                        msg.role === "user" ? "bg-primary/10 text-primary border border-primary/20" : "bg-secondary border border-border"
                      }`}>
                        {msg.role === "assistant" ? (
                          <div className="prose prose-invert prose-xs max-w-none">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        ) : msg.content}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex justify-start">
                      <div className="px-3 py-2 rounded-lg bg-secondary border border-border">
                        <div className="flex gap-1">
                          {[0, 1, 2].map((i) => (
                            <div key={i} className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>

              {selectedParcel && (
                <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/20">
                  <span className="text-[10px] text-primary flex-1 truncate">
                    Parcelle: {String(selectedParcel.NICAD || selectedParcel.nicad || "N/A")}
                  </span>
                  <button className="cursor-pointer" onClick={() => setSelectedParcel(null)}>
                    <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
                  placeholder="Ex: Quelles sont les erreurs critiques ?"
                  className="flex-1 text-xs px-3 py-2 rounded-lg border border-border bg-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                  disabled={chatLoading}
                />
                <Button size="sm" onClick={handleChat} disabled={chatLoading || !chatInput.trim()} className="h-9 px-3">
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </TabsContent>
          </Tabs>

          {/* Error detail panel */}
          {selectedError && (
            <div className="border-t border-border p-4 bg-card/50">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold">Détail de l&apos;erreur</p>
                <button className="cursor-pointer" onClick={() => setSelectedError(null)}>
                  <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p><strong className="text-foreground">Type:</strong> {selectedError.errorType}</p>
                <p><strong className="text-foreground">Sévérité:</strong> {SEVERITY_LABELS[selectedError.severity]}</p>
                {selectedError.nicad1 && <p><strong className="text-foreground">NICAD:</strong> {selectedError.nicad1}</p>}
                {selectedError.area && <p><strong className="text-foreground">Surface:</strong> {selectedError.area.toFixed(2)} m²</p>}
                {selectedError.description && <p className="mt-1 leading-relaxed">{selectedError.description}</p>}
              </div>

              {selectedError.corrected || correctedErrorIds.has(selectedError.id) ? (
                <p className="mt-3 pt-3 border-t border-border/50 text-[11px] text-green-400 flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5" /> Erreur corrigée
                </p>
              ) : (
                <div className="mt-3 pt-3 border-t border-border/50 space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Corriger</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed pb-1">
                    Choisissez une action pour appliquer la correction. Elle est exécutée immédiatement
                    et le résultat est téléchargeable via le bouton <strong>« Télécharger »</strong>.
                  </p>
                  {selectedError.errorType === "OVERLAP" && (
                    <>
                      <Button
                        size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => handleCorrectError(selectedError.id, "clip_first")}
                      >
                        <Wrench className="w-3 h-3" /> Découper {selectedError.nicad1 ?? "parcelle 1"}
                      </Button>
                      <Button
                        size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => handleCorrectError(selectedError.id, "clip_second")}
                      >
                        <Wrench className="w-3 h-3" /> Découper {selectedError.nicad2 ?? "parcelle 2"}
                      </Button>
                    </>
                  )}
                  {selectedError.errorType === "SLIVER" && (
                    <>
                      <Button
                        size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => handleCorrectError(selectedError.id, "merge_neighbor")}
                      >
                        <Wrench className="w-3 h-3" /> Fusionner avec la parcelle voisine
                      </Button>
                      <Button
                        size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => handleCorrectError(selectedError.id, "delete")}
                      >
                        <Trash2 className="w-3 h-3" /> Supprimer le sliver
                      </Button>
                    </>
                  )}
                  {selectedError.errorType === "GAP" && (
                    <Button
                      size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() => handleCorrectError(selectedError.id, "assign_to_neighbor")}
                    >
                      <Wrench className="w-3 h-3" /> Combler avec {selectedError.nicad1 ?? "la parcelle adjacente"}
                    </Button>
                  )}
                  {selectedError.errorType === "BOUNDARY_CROSS" && (
                    <Button
                      size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() => handleCorrectError(selectedError.id, "truncate")}
                    >
                      <Wrench className="w-3 h-3" /> Tronquer à la limite administrative
                    </Button>
                  )}
                  {selectedError.errorType === "INVALID_GEOM" && (
                    <Button
                      size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() => handleCorrectError(selectedError.id, "delete")}
                    >
                      <Trash2 className="w-3 h-3" /> Supprimer la géométrie invalide
                    </Button>
                  )}
                  {selectedError.errorType === "DUPLICATE" && (
                    <Button
                      size="sm" variant="outline" className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() => handleCorrectError(selectedError.id, "delete")}
                    >
                      <Trash2 className="w-3 h-3" /> Supprimer cette occurrence du doublon
                    </Button>
                  )}
                  {(selectedError.errorType === "MISSING_NICAD" || selectedError.errorType === "SHORT_NICAD") && (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={nicadAssignValue}
                        onChange={(e) => setNicadAssignValue(e.target.value)}
                        placeholder={selectedError.errorType === "SHORT_NICAD" ? "NICAD corrigé (vide = AUTO)" : "NICAD (vide = AUTO)"}
                        className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Button
                        size="sm" variant="outline" className="h-7 px-2 text-xs gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => {
                          handleCorrectError(selectedError.id, "assign_nicad", nicadAssignValue.trim() || undefined);
                          setNicadAssignValue("");
                        }}
                      >
                        <Wrench className="w-3 h-3" /> Assigner
                      </Button>
                    </div>
                  )}
                  <Button
                    size="sm" variant="ghost" className="w-full h-7 text-xs justify-start gap-1.5 text-muted-foreground"
                    disabled={correctingErrorId === selectedError.id}
                    onClick={() => handleCorrectError(selectedError.id, "ignore")}
                  >
                    <X className="w-3 h-3" /> Ignorer (intentionnel)
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Map + Attribute Table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 relative min-h-0">
            <MapLibreMap
              analysisId={analysis.id}
              tilesVersion={tileVersion}
              initialBounds={initialBounds}
              errors={filteredErrors}
              selectedErrorId={selectedError?.id}
              blinkIntense={(selectedError?.errorType ?? "").toUpperCase() === "DUPLICATE"}
              onFeatureClick={handleFeatureClick}
              selectedNicads={selectedNicads}
              focusTarget={focusTarget}
              searchedNicads={searchedNicad ? [searchedNicad] : []}
              conformeHighlight={showConforme}
              nonConformeNicads={nonConformeNicads}
            />
            {geoLoading && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 text-[11px] rounded-full bg-card/90 backdrop-blur-sm border border-border shadow-lg">
                <RefreshCw className="w-3 h-3 animate-spin text-primary" />
                Chargement des parcelles…
              </div>
            )}
            {/* Toggle button */}
            <button
              onClick={() => setTableOpen((o) => !o)}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-full bg-card/90 backdrop-blur-sm border border-border shadow-lg hover:bg-card transition-colors cursor-pointer"
            >
              <Table2 className="w-3 h-3" />
              Table attributaire
              {tableOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
            </button>
          </div>

          {/* Attribute table panel */}
          {tableOpen && (
            <div className="border-t border-border bg-card shrink-0 flex flex-col" style={{ height: 210 }}>
              {/* Header bar */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <Table2 className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs font-semibold">Table attributaire</span>
                  {tableRows.length > 0 && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-2">
                      <span>
                        {tableRows.length} parcelle{tableRows.length > 1 ? "s" : ""}
                        {selectedDupNicad
                          ? ` — doublon NICAD ${selectedDupNicad}`
                          : selectedError ? ` — ${selectedError.errorType}` : ""}
                      </span>
                      {tableRows.length >= 2 && (
                        <span className="text-yellow-400">· différences surlignées</span>
                      )}
                      <button
                        onClick={() => { setTableRows([]); setSelectedParcel(null); setSelectedRows(new Set()); }}
                        className="cursor-pointer underline hover:text-foreground transition-colors"
                      >
                        Tout effacer
                      </button>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {tableDeletable && (
                    <button
                      onClick={handleDeleteSelectedParcels}
                      disabled={selectedRows.size === 0 || deletingRows}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                      {deletingRows ? "Suppression…" : `Supprimer${selectedRows.size ? ` (${selectedRows.size})` : " les parcelles"}`}
                    </button>
                  )}
                  <button
                    onClick={() => { setTableOpen(false); setTableRows([]); setSelectedRows(new Set()); }}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Table content */}
              <div className="overflow-auto flex-1">
                {tableRows.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                    Cliquez une parcelle ou sélectionnez une erreur dans la liste
                  </div>
                ) : (
                  <AttributeTable
                    rows={tableRows}
                    selectable={tableDeletable}
                    selectedKeys={selectedRows}
                    onToggle={toggleRow}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Supprimer l&apos;analyse</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Cette action est irréversible.</p>
              </div>
            </div>

            {/* What will be deleted */}
            <div className="rounded-lg border border-border bg-secondary/30 p-4 mb-5 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Données supprimées</p>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Fichier</span>
                <span className="font-mono text-xs truncate max-w-[200px]">{analysis.fileName}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Parcelles</span>
                <span className="font-semibold">{(analysis.totalFeatures ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Erreurs détectées</span>
                <span className="font-semibold text-red-400">{analysis.errors.length}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Fichier GeoJSON sur disque</span>
                <span className="text-orange-400 text-xs">Supprimé définitivement</span>
              </div>
              {correctedData && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Données corrigées</span>
                  <span className="text-orange-400 text-xs">Supprimées définitivement</span>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowDeleteModal(false)}
                disabled={isDeleting}
              >
                Annuler
              </Button>
              <Button
                variant="destructive"
                className="flex-1 gap-2"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                <Trash2 className="w-4 h-4" />
                {isDeleting ? "Suppression..." : "Supprimer"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
