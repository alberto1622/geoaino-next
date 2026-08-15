"use client";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle,
  Brain,
  FileText,
  Download,
  Wrench,
  ChevronRight,
  MapPin,
  X,
  Trash2,
  Table2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Copy,
  Search,
  Layers,
  Undo2,
  Redo2,
  ChevronLeft,
} from "lucide-react";
import { useUndoHistory, useUndoRedoShortcuts } from "@/hooks/use-undo-history";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NavBar } from "@/components/NavBar";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { toNum, errorTypeColor } from "@/lib/utils";
import { useAnalysisUpdateListener } from "@/lib/analyses/live-refresh";

// ── Limites administratives (régions / départements / communes) ──────────────
// Mêmes contours nationaux (cad_communes_2026) que la page /cadastre/sections.
type AdminLevel = "regions" | "departements" | "communes";
const ADMIN_LEVELS: AdminLevel[] = ["regions", "departements", "communes"];
const ADMIN_STYLES: Record<AdminLevel, { label: string; color: string }> = {
  regions: { label: "Régions", color: "#b91c1c" },
  departements: { label: "Départements", color: "#b45309" },
  communes: { label: "Communes", color: "#0f766e" },
};

const MapLibreMap = dynamic(() => import("@/components/MapLibreMap"), {
  ssr: false,
});

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

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

// Réplique du critère moteur (geo-engine.isMissingNicadValue + longueur < 8) pour
// le calcul de repli des parcelles conformes côté client.
const MISSING_NICAD_VALUES = new Set([
  "",
  "null",
  "undefined",
  "na",
  "n/a",
  "néant",
  "neant",
  "aucun",
  "sans nicad",
  "0",
  "-",
]);
function isNicadProblematic(nicad: string): boolean {
  const v = nicad.trim().toLowerCase();
  if (MISSING_NICAD_VALUES.has(v)) return true;
  return nicad.trim().length < 8;
}

type BBox = [number, number, number, number];

// ── Historique annuler/rétablir (page /map) ─────────────────────────────────
// Instantané complet de l'état affecté par une édition (suppression de
// parcelle(s) ou renommage NICAD) : suffit à la fois pour ré-écrire le serveur
// (correctedGeoJson + flags corrected) et pour ré-afficher la table/sélection
// exactement comme elles étaient à ce moment.
type MapSnapshot = {
  correctedGeoJson: string;
  errorPatches: { errorId: number; corrected: boolean }[];
  tableRows: Record<string, unknown>[];
  selectedRows: Set<number>;
  deletedNicads: string[];
};
type MapHistoryEntry = {
  kind: "delete" | "rename";
  before: MapSnapshot;
  after: MapSnapshot;
};

// Clés de propriété portant le NICAD (alignées sur geo-engine.extractNicad et
// feature-locator.NICAD_KEYS côté serveur).
const NICAD_KEYS = [
  "nicad",
  "NICAD",
  "Nicad",
  "NIC",
  "NUM_NICAD",
  "num_nicad",
  "CODE_NICAD",
  "code_nicad",
  "CODIF",
  "codif",
];

/** NICAD affiché d'une ligne de la table (ordre de repli des variantes usuelles). */
function rowNicad(r: Record<string, unknown>): string {
  return String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? "").trim();
}

/** Réécrit le NICAD d'une ligne sur toutes ses clés porteuses (+ `nicad`). */
function withRowNicad(
  r: Record<string, unknown>,
  nicad: string,
): Record<string, unknown> {
  const next = { ...r };
  for (const k of NICAD_KEYS) if (k in next) next[k] = nicad;
  next.nicad = nicad;
  return next;
}

// Emprise [w,s,e,n] d'une géométrie GeoJSON (WGS84). Sert à annoter/zoomer les
// occurrences d'un doublon quand le GeoJSON complet est chargé côté client.
function geomBbox(geom: unknown): BBox | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  let found = false;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lng = c[0] as number,
        lat = c[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        found = true;
        if (lng < w) w = lng;
        if (lat < s) s = lat;
        if (lng > e) e = lng;
        if (lat > n) n = lat;
      }
    } else {
      for (const i of c) walk(i);
    }
  };
  const g = geom as { coordinates?: unknown } | null;
  if (g?.coordinates) walk(g.coordinates);
  return found ? [w, s, e, n] : null;
}

// Dérive les centroïdes numérotés + l'emprise englobante des occurrences d'un
// doublon à partir de leurs `_bbox`. Ignore les occurrences sans géométrie
// ([0,0,0,0], marqueur « absent » posé côté serveur).
function occurrencesFromMembers(members: Record<string, unknown>[]): {
  occ: { lng: number; lat: number; label: string }[];
  bounds: BBox | null;
} {
  const occ: { lng: number; lat: number; label: string }[] = [];
  let bounds: BBox | null = null;
  members.forEach((m, i) => {
    const b = m._bbox as BBox | undefined;
    if (
      !Array.isArray(b) ||
      b.length !== 4 ||
      !b.every((x) => Number.isFinite(x))
    )
      return;
    const [w, s, e, n] = b;
    if (w === 0 && s === 0 && e === 0 && n === 0) return;
    occ.push({ lng: (w + e) / 2, lat: (s + n) / 2, label: String(i + 1) });
    bounds = bounds
      ? [
          Math.min(bounds[0], w),
          Math.min(bounds[1], s),
          Math.max(bounds[2], e),
          Math.max(bounds[3], n),
        ]
      : [w, s, e, n];
  });
  return { occ, bounds };
}

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Critique",
  HIGH: "Élevé",
  MEDIUM: "Moyen",
  LOW: "Faible",
};

// Cellule d'action « mode édition doublon » : réassigner le NICAD de cette
// occurrence (input local) ou la conserver en supprimant les autres. L'input est
// pré-rempli au NICAD courant et remis à jour quand celui-ci change (rename/suppr.).
function OccurrenceEditActions({
  index,
  current,
  onRename,
  onKeepOnly,
}: {
  index: number;
  current: string;
  onRename?: (index: number, nicad: string) => void;
  onKeepOnly?: (index: number) => void;
}) {
  // `current` change (rename/ré-indexation) → la clé au point d'appel remonte le
  // composant, ré-initialisant l'input ; pas de setState en effet.
  const [value, setValue] = useState(current);
  const trimmed = value.trim();
  return (
    <div className="flex items-center gap-1 justify-center">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed && trimmed !== current)
            onRename?.(index, trimmed);
        }}
        placeholder="Nouveau NICAD"
        className="w-28 h-6 rounded border border-border bg-background px-1.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        title="Nouveau NICAD pour cette occurrence"
      />
      <button
        onClick={() => onRename?.(index, trimmed)}
        disabled={!trimmed || trimmed === current}
        className="cursor-pointer px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        title="Réassigner ce NICAD à l'occurrence sélectionnée"
      >
        Renommer
      </button>
      <button
        onClick={() => onKeepOnly?.(index)}
        className="cursor-pointer px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-400 hover:bg-green-500/25 transition-colors whitespace-nowrap"
        title="Conserver cette occurrence et supprimer les autres du même NICAD"
      >
        Conserver
      </button>
    </div>
  );
}

function AttributeTable({
  rows,
  selectable = false,
  selectedKeys,
  onToggle,
  onToggleAll,
  editMode = false,
  onKeepOnly,
  onRename,
}: {
  rows: Record<string, unknown>[];
  /** Affiche une colonne de cases à cocher (parcelles supprimables, clé = index de ligne). */
  selectable?: boolean;
  /** Index (dans `rows`) des lignes cochées. */
  selectedKeys?: Set<number>;
  onToggle?: (index: number) => void;
  /** Coche/décoche toutes les lignes (case à cocher d'en-tête). */
  onToggleAll?: () => void;
  /** Mode édition doublons : ajoute une colonne d'actions (renommer / conserver) par occurrence. */
  editMode?: boolean;
  /** Conserve l'occurrence `index` et supprime les autres du même NICAD. */
  onKeepOnly?: (index: number) => void;
  /** Réassigne le NICAD `nicad` à l'occurrence `index`. */
  onRename?: (index: number, nicad: string) => void;
}) {
  const allKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cols = [
    ...allKeys.filter((k) => k === "_role"),
    ...allKeys.filter((k) => !k.startsWith("_")),
  ];
  const isDiff = (col: string) =>
    rows.length === 2 &&
    String(rows[0][col] ?? "") !== String(rows[1][col] ?? "");

  return (
    <table className="text-[11px] w-full border-collapse">
      <thead className="sticky top-0 bg-card z-10">
        <tr>
          {selectable && (
            <th className="px-2 py-1.5 border-b border-border bg-card w-8 text-center">
              <input
                type="checkbox"
                className="cursor-pointer accent-red-500"
                checked={
                  rows.length > 0 && (selectedKeys?.size ?? 0) === rows.length
                }
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      (selectedKeys?.size ?? 0) > 0 &&
                      (selectedKeys?.size ?? 0) < rows.length;
                }}
                onChange={() => onToggleAll?.()}
                title="Tout sélectionner / tout désélectionner"
              />
            </th>
          )}
          {editMode && (
            <th className="px-2 py-1.5 border-b border-border bg-card text-center font-medium text-muted-foreground whitespace-nowrap">
              Action
            </th>
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
              {editMode && (
                <td className="px-2 py-1 border-b border-border/40">
                  <OccurrenceEditActions
                    key={`occ-edit-${i}-${rowNicad(row)}`}
                    index={i}
                    current={rowNicad(row)}
                    onRename={onRename}
                    onKeepOnly={onKeepOnly}
                  />
                </td>
              )}
              {cols.map((col) => (
                <td
                  key={col}
                  className={[
                    "px-2.5 py-1 border-b border-border/40 whitespace-nowrap",
                    col === "_role" ? "font-medium text-primary" : "font-mono",
                    isDiff(col)
                      ? "bg-yellow-500/15 text-yellow-300 font-semibold"
                      : "",
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
  // Mode édition des doublures : marqueurs cliquables + action « Conserver » par
  // occurrence dans la table attributaire (résout un doublon en un clic).
  const [dupEditMode, setDupEditMode] = useState(false);
  // Annotations d'occurrences (centroïdes numérotés) + emprise englobante pour le
  // zoom, alimentées au clic sur une doublure.
  const [dupOccurrences, setDupOccurrences] = useState<
    { lng: number; lat: number; label: string }[]
  >([]);
  const [dupBounds, setDupBounds] = useState<BBox | null>(null);
  // Garde anti double-soumission d'une réassignation de NICAD en cours.
  const renamingRef = useRef(false);
  // Lignes cochées (index dans `tableRows`) pour suppression de parcelles.
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  // Confirmation en attente pour les actions destructives (remplace window.confirm).
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
  const [deletingRows, setDeletingRows] = useState(false);
  const [selectedParcel, setSelectedParcel] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [correctedData, setCorrectedData] = useState<string | null>(
    analysis.correctedData,
  );
  // Tier 2 : GeoJSON récupéré via API et parsé une seule fois (objet partagé
  // entre la carte, la table attributaire et la recherche NICAD).
  const [displayFc, setDisplayFc] = useState<GeoJSON.FeatureCollection | null>(
    null,
  );
  // Jeu volumineux : pas de chargement du FC complet → pas d'état « en cours ».
  const [geoLoading, setGeoLoading] = useState(
    () => (analysis.totalFeatures ?? 0) <= 20000,
  );
  // Limites de sections (table limite_section) + numéros affichées sur la carte.
  const [showSections, setShowSections] = useState(false);
  // Parcelles SANS section rattachée (numero_section absent/« 000 ») colorées
  // en orange : leur NICAD porte une section indéterminée.
  const [showSansSection, setShowSansSection] = useState(true);
  const [sansSectionCount, setSansSectionCount] = useState<number | null>(null);
  // Attribution en masse des NICAD manquants (incrémentation + plus proche
  // voisin, cf. `nicad-fill-missing.ts`) — un seul indicateur pour l'aperçu
  // (dryRun) ET l'application, jamais actifs simultanément.
  const [fillingNicad, setFillingNicad] = useState(false);
  // Aperçu par section (dryRun) affiché dans le sélecteur de sections, et
  // sous-ensemble actuellement coché par l'utilisateur (tout coché par défaut).
  const [nicadFillPreview, setNicadFillPreview] = useState<{
    plans: {
      numSection: string;
      count: number;
      fromParcelle: string;
      toParcelle: string;
      viaCommune2026?: boolean;
      communeApprox?: boolean;
      crossFileSection?: boolean;
      sectionSourceFichier?: string;
    }[];
    unresolvedCount: number;
  } | null>(null);
  const [nicadFillSelection, setNicadFillSelection] = useState<Set<string>>(
    new Set(),
  );
  // Limites administratives (référentiel national, mêmes contours que /cadastre/sections).
  const [adminShow, setAdminShow] = useState<Record<AdminLevel, boolean>>({
    regions: false,
    departements: false,
    communes: false,
  });
  // Masque/affiche le panneau latéral gauche pour libérer de l'espace carte.
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [isSavingReport, setIsSavingReport] = useState(false);
  const [isRegeneratingReport, setIsRegeneratingReport] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(analysis.aiReport);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([]);
  const [tableOpen, setTableOpen] = useState(false);
  const [nicadSearch, setNicadSearch] = useState("");
  const [focusTarget, setFocusTarget] = useState<{
    nicad: string;
    key: number;
  } | null>(null);
  const [searchedNicad, setSearchedNicad] = useState<string | null>(null);
  const [correctingErrorId, setCorrectingErrorId] = useState<number | null>(
    null,
  );
  const [correctedErrorIds, setCorrectedErrorIds] = useState<Set<number>>(
    new Set(),
  );
  // `errorCount`/`conformityScore` renvoyés par le serveur après CHAQUE
  // correction (`correct/route.ts` les patche et les persiste désormais en
  // base) — remplace `analysis.errorCount`/`analysis.conformityScore` (figés
  // au chargement de la page) dès la première correction de cette session.
  // `null` = aucune correction faite depuis le chargement, afficher les
  // valeurs du serveur telles quelles.
  const [statsOverride, setStatsOverride] = useState<{
    errorCount: number;
    conformityScore: number;
  } | null>(null);
  // NICAD supprimés récemment : masqués immédiatement sur la carte (filtre vecteur)
  // en attendant que les tuiles MVT se resynchronisent (tilesVersion) sans reload visible.
  const [deletedNicads, setDeletedNicads] = useState<string[]>([]);
  const [nicadAssignValue, setNicadAssignValue] = useState("");
  const [sectionAssignValue, setSectionAssignValue] = useState("");
  // Historique annuler/rétablir des éditions de la table attributaire (suppression
  // de parcelle(s), renommage NICAD) — cf. type MapHistoryEntry.
  const mapHistory = useUndoHistory<MapHistoryEntry>();
  const [restoringHistory, setRestoringHistory] = useState(false);
  // Réf « toujours à jour » vers `performUndo` (défini plus bas) : permet au
  // bouton « Annuler » du toast de suppression de l'appeler sans figer une
  // closure périmée ni réordonner les déclarations.
  const performUndoRef = useRef<() => Promise<void>>(async () => {});
  // Rendu par tuiles vectorielles (MVT) : emprise globale pour le fit initial,
  // et version incrémentée à chaque correction pour invalider le cache des tuiles.
  const [initialBounds, setInitialBounds] = useState<
    [number, number, number, number] | null
  >(null);
  const [tileVersion, setTileVersion] = useState(0);

  // Au-delà de ce seuil, on ne charge PAS tout le GeoJSON côté client (OOM
  // navigateur) : la carte s'appuie sur les tuiles vectorielles, et les panneaux
  // détaillés (table complète, recherche locale) sont dérivés à la demande.
  const LARGE_DATASET = (analysis.totalFeatures ?? 0) > 20000;

  const sortedErrors = useMemo(
    () =>
      [...analysis.errors].sort(
        (a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4),
      ),
    [analysis.errors],
  );

  const filteredErrors = useMemo(
    () =>
      activeFilters.size > 0
        ? sortedErrors.filter((e) => activeFilters.has(e.errorType))
        : sortedErrors,
    [sortedErrors, activeFilters],
  );

  // Erreurs affichées sur la CARTE (marqueurs/surbrillance) : contrairement à
  // la liste latérale (`filteredErrors`, qui garde volontairement les erreurs
  // corrigées — grisées — pour laisser l'historique visible), une erreur
  // corrigée ne doit plus apparaître comme active sur la carte. `e.corrected`
  // couvre les corrections d'une session précédente (rechargées depuis le
  // serveur, `map/[analysisId]/page.tsx` ne filtre pas `corrected: false` —
  // la liste latérale en a besoin) ; `correctedErrorIds` couvre celles faites
  // DANS cette session (pas encore reflétées dans `analysis.errors`, prop figée
  // au chargement).
  const mapErrors = useMemo(
    () =>
      filteredErrors.filter(
        (e) => !e.corrected && !correctedErrorIds.has(e.id),
      ),
    [filteredErrors, correctedErrorIds],
  );

  const errorTypeGroups = useMemo(
    () => Array.from(new Set(analysis.errors.map((e) => e.errorType))),
    [analysis.errors],
  );

  // NICAD distincts impliqués dans au moins une erreur NON corrigée (= parcelles
  // non conformes) — une erreur corrigée (chargée `corrected: true`, ou corrigée
  // DANS cette session via `correctedErrorIds`) ne doit plus retenir sa parcelle
  // hors de la classification « conforme » (cf. `conformeFilter`, MapLibreMap.tsx) :
  // sans ce filtre, une parcelle reste rouge sur la carte indéfiniment après
  // correction de sa dernière erreur.
  const nonConformeNicads = useMemo(() => {
    const s = new Set<string>();
    for (const e of analysis.errors) {
      if (e.corrected || correctedErrorIds.has(e.id)) continue;
      if (e.nicad1) s.add(e.nicad1);
      if (e.nicad2) s.add(e.nicad2);
    }
    return Array.from(s);
  }, [analysis.errors, correctedErrorIds]);

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

  // `conformeCount`/`analysis.errorCount` restent figés à l'état du serveur au
  // chargement de la page (§ ci-dessus) : une correction faite DANS cet onglet
  // (attribution NICAD, correction manuelle d'une erreur) ou notifiée par un
  // autre onglet (`handleExternalAnalysisUpdate`) grossit `correctedErrorIds`
  // sans jamais rafraîchir ces deux compteurs. Le sidebar affichait donc un
  // nombre d'erreurs/conformes obsolète juste après avoir attribué des NICAD
  // manquants (§ 11 quinquies-octies, docs/CONCEPTS-TRAITEMENT-DXF.md).
  // `correctedErrorIds.size` est la référence déjà utilisée ailleurs (opacité/
  // barré de la liste d'erreurs) pour « corrigé depuis le chargement » — décale
  // les deux compteurs du même delta plutôt que de les recalculer de zéro.
  const correctedSinceLoad = correctedErrorIds.size;
  // Repli (`analysis.conformeCount == null`) : `conformeCount` est déjà
  // recalculé dynamiquement depuis `nonConformeNicads`, qui exclut désormais
  // les erreurs corrigées — ne PAS lui rajouter `correctedSinceLoad`, sinon
  // double comptage. Seule la valeur AUTORITATIVE figée au chargement en a besoin.
  const displayConformeCount =
    conformeCount == null
      ? null
      : analysis.conformeCount != null
        ? conformeCount + correctedSinceLoad
        : conformeCount;
<<<<<<< HEAD
  const displayErrorCount = Math.max(
    0,
    (analysis.errorCount ?? 0) - correctedSinceLoad,
  );
=======
  // `statsOverride` (posé par `handleCorrectError` depuis la réponse de
  // `correct/route.ts`, qui patche et persiste désormais `errorCount`/
  // `conformityScore` en base à chaque correction) est la valeur EXACTE,
  // cumulée sur toutes les corrections de cette session — préférée à
  // l'approximation `correctedSinceLoad` (poids uniforme -1, ne distingue pas
  // les sévérités) dès qu'une correction est passée par ce chemin.
  const displayErrorCount =
    statsOverride?.errorCount ?? Math.max(0, (analysis.errorCount ?? 0) - correctedSinceLoad);
  const displayConformityScore = statsOverride?.conformityScore ?? toNum(analysis.conformityScore);

>>>>>>> worktree-shapefile-parcelles-section-coherence
  // Emprise globale pour le fit initial de la carte (rendu par tuiles) : servie
  // par map-meta, indépendante du chargement du GeoJSON complet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/map-meta`);
        if (!res.ok) return;
        const meta = (await res.json()) as {
          bbox: [number, number, number, number] | null;
          sansSection?: number;
        };
        if (!cancelled) {
          setInitialBounds(meta.bbox);
          setSansSectionCount(
            typeof meta.sansSection === "number" ? meta.sansSection : null,
          );
        }
      } catch {
        /* le fit initial est optionnel */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysis.id, tileVersion]);

  // Rafraîchissement en direct : une autre page (ex. attribution/modification
  // d'un numéro de section dans `cadastre/sections`) a reconstruit le NICAD de
  // parcelles de CETTE analyse pendant que cet onglet est déjà ouvert.
  // `tileVersion++` couvre à la fois les tuiles (couleurs `_nstat`/`_ssec`/
  // doublure) ET le KPI `sansSectionCount` (même effet ci-dessus, déjà
  // dépendant de `tileVersion`) ; les erreurs DUPLICATE potentiellement
  // résolues par la synchronisation sont, elles, rechargées explicitement pour
  // sortir des superpositions/panneaux d'erreurs actifs sans recharger la page.
  const handleExternalAnalysisUpdate = useCallback(() => {
    setTileVersion((v) => v + 1);
    (async () => {
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/errors`);
        if (!res.ok) return;
        const fresh = (await res.json()) as {
          id: number;
          corrected: boolean;
        }[];
        const newlyCorrected = fresh
          .filter((e) => e.corrected)
          .map((e) => e.id);
        if (newlyCorrected.length > 0) {
          setCorrectedErrorIds((prev) => new Set([...prev, ...newlyCorrected]));
        }
      } catch {
        /* rafraîchissement best-effort */
      }
    })();
    toast.info(
      "Carte mise à jour — un numéro de section a été modifié ailleurs.",
    );
  }, [analysis.id]);
  useAnalysisUpdateListener(analysis.id, handleExternalAnalysisUpdate);

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
    return () => {
      cancelled = true;
    };
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

  // Lookup map: NICAD → ALL features (needed for duplicate group comparison).
  // On attache `_bbox` (emprise WGS84 dérivée de la géométrie) pour permettre le
  // zoom/annotation des occurrences et leur localisation précise à la suppression,
  // de la même façon que les membres servis par l'endpoint `nicad-group`.
  const nicadToAllFeatures = useMemo<
    Map<string, Record<string, unknown>[]>
  >(() => {
    const m = new Map<string, Record<string, unknown>[]>();
    for (const feat of displayFc?.features ?? []) {
      const p = (feat.properties ?? {}) as Record<string, unknown>;
      const nicad = String(p.NICAD ?? p.nicad ?? p.NIC ?? p.Nicad ?? "");
      if (nicad) {
        if (!m.has(nicad)) m.set(nicad, []);
        const b = feat.geometry ? geomBbox(feat.geometry) : null;
        m.get(nicad)!.push(b ? { ...p, _bbox: b } : p);
      }
    }
    return m;
  }, [displayFc]);

  // Duplicate groups: one entry per unique NICAD with multiple occurrences.
  // (errorType est stocké en MAJUSCULES côté DB — comparaison insensible à la casse.)
  const duplicateGroups = useMemo(() => {
    const grouped = new Map<
      string,
      { errors: GeoError[]; objectIds: string[] }
    >();
    for (const e of analysis.errors) {
      if (e.errorType?.toUpperCase() !== "DUPLICATE" || !e.nicad1) continue;
      if (!grouped.has(e.nicad1))
        grouped.set(e.nicad1, { errors: [], objectIds: [] });
      grouped.get(e.nicad1)!.errors.push(e);
      if (e.nicad2) grouped.get(e.nicad1)!.objectIds.push(e.nicad2);
    }
    return Array.from(grouped.entries()).map(
      ([nicad, { errors, objectIds }]) => ({
        nicad,
        errors,
        objectIds,
        count: errors.length,
      }),
    );
  }, [analysis.errors]);

  // NICAD dupliqués (lookup O(1)) pour déclencher l'affichage du groupe au clic.
  const duplicateNicadSet = useMemo(
    () => new Set(duplicateGroups.map((g) => g.nicad)),
    [duplicateGroups],
  );

  // Récupère toutes les parcelles d'un même NICAD : cache local (petits jeux) ou
  // endpoint serveur (gros jeux, `displayFc` non chargé).
  const fetchNicadGroup = useCallback(
    async (nicad: string): Promise<Record<string, unknown>[]> => {
      const local = nicadToAllFeatures.get(nicad);
      if (local && local.length) return local;
      try {
        const res = await fetch(
          `/api/analyses/${analysis.id}/nicad-group?nicad=${encodeURIComponent(nicad)}`,
        );
        if (!res.ok) return [];
        const data = (await res.json()) as {
          members: Record<string, unknown>[];
        };
        return data.members ?? [];
      } catch {
        return [];
      }
    },
    [analysis.id, nicadToAllFeatures],
  );

  // Pose les annotations d'occurrences + l'emprise de zoom à partir des membres
  // d'un doublon (chacun porte `_bbox`). Les labels suivent l'ordre des lignes de
  // la table (« Occurrence N »).
  const applyOccurrenceMarkers = useCallback(
    (members: Record<string, unknown>[]) => {
      const { occ, bounds } = occurrencesFromMembers(members);
      setDupOccurrences(occ);
      setDupBounds(bounds);
    },
    [],
  );

  // Sort du contexte « doublon » : efface la sélection de groupe et ses annotations.
  const clearDuplicateFocus = useCallback(() => {
    setSelectedDupNicad(null);
    setDupOccurrences([]);
    setDupBounds(null);
  }, []);

  const handleFeatureClick = useCallback(
    (props: Record<string, unknown>, point?: { lng: number; lat: number }) => {
      setSelectedParcel(props);
      setSearchedNicad(null);
      const clean = Object.fromEntries(
        Object.entries(props).filter(([k]) => !k.startsWith("_")),
      );
      // Point intérieur (clic carte) conservé comme localisateur fiable pour la
      // suppression de cette parcelle depuis la table attributaire.
      if (point) clean._point = [point.lng, point.lat];
      const nicad = String(
        clean.NICAD ?? clean.nicad ?? clean.NIC ?? clean.Nicad ?? "",
      );
      // Pont carte → panneau de correction : si la parcelle cliquée est impliquée
      // dans une erreur non corrigée, on la sélectionne pour ouvrir les actions.
      if (nicad) {
        const match = analysis.errors.find(
          (e) =>
            !e.corrected &&
            !correctedErrorIds.has(e.id) &&
            (e.nicad1 === nicad || e.nicad2 === nicad),
        );
        if (match) setSelectedError(match);

        // Parcelle à NICAD dupliqué : afficher TOUTES les occurrences de ce NICAD
        // dans la table attributaire (récupérées côté serveur si nécessaire). Le
        // clignotement s'intensifie automatiquement (selectedError = DUPLICATE).
        if (duplicateNicadSet.has(nicad)) {
          setSelectedDupNicad(nicad);
          setSelectedRows(new Set());
          setDupOccurrences([]);
          setDupBounds(null);
          setTableOpen(true);
          void fetchNicadGroup(nicad).then((members) => {
            if (members.length > 1) {
              setTableRows(
                members.map((p, i) => ({ _role: `Occurrence ${i + 1}`, ...p })),
              );
              applyOccurrenceMarkers(members);
            }
          });
          return;
        }
      }

      clearDuplicateFocus();
      setTableRows((prev) => {
        const idx = prev.findIndex(
          (r) =>
            String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? "") === nicad &&
            nicad !== "",
        );
        const next =
          idx >= 0 ? prev.filter((_, i) => i !== idx) : [...prev, clean];
        return next.map((r, i) => ({
          ...r,
          _role: next.length === 1 ? "Sélectionné" : `P${i + 1}`,
        }));
      });
      setTableOpen(true);
    },
    [
      analysis.errors,
      correctedErrorIds,
      duplicateNicadSet,
      fetchNicadGroup,
      applyOccurrenceMarkers,
      clearDuplicateFocus,
    ],
  );

  // Select a duplicate group → zoom sur toutes les occurrences + annotations +
  // table de comparaison. Le blink intense reste piloté par `selectedError`.
  const selectDuplicateGroup = useCallback(
    (group: { nicad: string; errors: GeoError[]; objectIds: string[] }) => {
      setSearchedNicad(null);
      setSelectedDupNicad(group.nicad);
      setSelectedError(group.errors[0] ?? null); // blink intense (le zoom = emprise des occurrences)
      setTableOpen(true);
      setSelectedRows(new Set());
      setDupOccurrences([]);
      setDupBounds(null);
      void fetchNicadGroup(group.nicad).then((members) => {
        if (members.length > 0) {
          setTableRows(
            members.map((p, i) => ({ _role: `Occurrence ${i + 1}`, ...p })),
          );
          applyOccurrenceMarkers(members);
        }
      });
    },
    [fetchNicadGroup, applyOccurrenceMarkers],
  );

  const toggleRow = useCallback((index: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Coche/décoche toutes les lignes de la table attributaire. Décoche tout si
  // déjà toutes sélectionnées, sinon sélectionne l'ensemble des lignes.
  const toggleAllRows = useCallback(() => {
    setSelectedRows((prev) =>
      prev.size === tableRows.length
        ? new Set()
        : new Set(tableRows.map((_, i) => i)),
    );
  }, [tableRows]);

  // Supprime les lignes `indices` de la table attributaire. Chaque ligne est
  // localisée de façon fiable : point intérieur (clic carte), emprise
  // (occurrence d'un groupe NICAD) ou NICAD (repli). L'édition est écrite dans
  // `correctedData` côté serveur ; les erreurs de topologie rattachées
  // (`_errorId`) sont marquées corrigées. Confirmation requise, annulable via
  // l'historique (Ctrl+Z / mapHistory).
  const performDeleteRows = useCallback(
    async (indices: number[]) => {
      const sorted = [...indices].sort((a, b) => a - b);
      const rows = sorted.map((i) => tableRows[i]).filter(Boolean);
      if (rows.length === 0) return;

      const locators = rows.map((r) => ({
        point: Array.isArray(r._point)
          ? (r._point as [number, number])
          : undefined,
        bbox:
          Array.isArray(r._bbox) && r._bbox.length === 4
            ? (r._bbox as [number, number, number, number])
            : undefined,
        nicad:
          String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? "").trim() ||
          undefined,
      }));
      const nicadsToHide = locators
        .map((l) => l.nicad)
        .filter((n): n is string => !!n);
      const errorIds = rows
        .map((r) => (typeof r._errorId === "number" ? r._errorId : null))
        .filter((x): x is number => x !== null);

      setDeletingRows(true);
      const toastId = toast.loading(
        `Suppression de ${rows.length} parcelle${rows.length > 1 ? "s" : ""} en cours…`,
      );
      try {
        const res = await fetch(
          `/api/analyses/${analysis.id}/features/delete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locators, errorIds }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Suppression échouée");
        const beforeSnapshot: MapSnapshot = {
          correctedGeoJson:
            data.previousCorrectedGeoJson ?? correctedData ?? "",
          errorPatches: errorIds.map((eid) => ({
            errorId: eid,
            corrected: correctedErrorIds.has(eid),
          })),
          tableRows,
          selectedRows: new Set(selectedRows),
          deletedNicads,
        };
        if (data.correctedGeoJson) setCorrectedData(data.correctedGeoJson);
        if (nicadsToHide.length > 0) {
          setDeletedNicads((prev) => [...prev, ...nicadsToHide]);
        }
        setTileVersion((v) => v + 1); // rafraîchit les tuiles (parcelles retirées)
        for (const eid of errorIds)
          setCorrectedErrorIds((prev) => new Set(prev).add(eid));
        const removeSet = new Set(sorted);
        const remainingCount = tableRows.length - removeSet.size;
        const remaining = tableRows
          .filter((_, i) => !removeSet.has(i))
          .map((r, i) => ({
            ...r,
            _role: String(r._role ?? "").startsWith("Occurrence")
              ? `Occurrence ${i + 1}`
              : remainingCount === 1
                ? "Sélectionné"
                : `P${i + 1}`,
          }));
        setTableRows(remaining);
        setSelectedRows(new Set());
        mapHistory.push({
          kind: "delete",
          before: beforeSnapshot,
          after: {
            correctedGeoJson:
              data.correctedGeoJson ?? beforeSnapshot.correctedGeoJson,
            errorPatches: errorIds.map((eid) => ({
              errorId: eid,
              corrected: true,
            })),
            tableRows: remaining,
            selectedRows: new Set(),
            deletedNicads: [...deletedNicads, ...nicadsToHide],
          },
        });
        // Réaligne les annotations d'occurrences sur ce qui reste du doublon.
        if (selectedDupNicad) applyOccurrenceMarkers(remaining);
        // Bouton « Annuler » directement dans le toast (en plus de Ctrl+Z) :
        // reprend la même sémantique « annule le sommet de la pile » que
        // `performUndo`/le raccourci clavier — l'entrée qu'on vient de pousser
        // est déjà en haut, donc cliquer juste après la suppression annule
        // bien CETTE suppression (si une autre action a lieu entre-temps,
        // Annuler annule celle-là à la place, comme le ferait Ctrl+Z).
        toast.success(`${data.deleted} parcelle(s) supprimée(s)`, {
          id: toastId,
          action: {
            label: "Annuler",
            onClick: () => void performUndoRef.current(),
          },
        });
        if (data.notFound > 0)
          toast.warning(
            `${data.notFound} parcelle(s) non localisée(s) — ignorée(s)`,
          );
      } catch (err) {
        toast.error(String(err), { id: toastId });
      } finally {
        setDeletingRows(false);
      }
    },
    [
      tableRows,
      analysis.id,
      selectedDupNicad,
      applyOccurrenceMarkers,
      correctedData,
      correctedErrorIds,
      selectedRows,
      deletedNicads,
      mapHistory,
    ],
  );

  const deleteRows = useCallback(
    (indices: number[], confirmMsg?: string) => {
      const count = indices.filter((i) => tableRows[i]).length;
      if (count === 0) return;
      setConfirmState({
        title: "Supprimer des parcelles",
        description:
          confirmMsg ??
          `Supprimer ${count} parcelle${count > 1 ? "s" : ""} ?\nCette action modifie les données de l'analyse (annulable avec Ctrl+Z).`,
        confirmLabel: "Supprimer",
        run: () => void performDeleteRows(indices),
      });
    },
    [tableRows, performDeleteRows],
  );

  const handleDeleteSelectedParcels = useCallback(
    () => deleteRows(Array.from(selectedRows)),
    [deleteRows, selectedRows],
  );

  // Mode édition doublons : conserve l'occurrence `keepIndex` et supprime toutes
  // les autres occurrences du même NICAD (résolution du doublon en un clic).
  const handleKeepOnlyOccurrence = useCallback(
    (keepIndex: number) => {
      const others = tableRows.map((_, i) => i).filter((i) => i !== keepIndex);
      if (others.length === 0) {
        toast.info("Une seule occurrence — rien à supprimer.");
        return;
      }
      const keptRole = String(
        tableRows[keepIndex]?._role ?? `Occurrence ${keepIndex + 1}`,
      );
      deleteRows(
        others,
        `Conserver « ${keptRole} » et supprimer les ${others.length} autre(s) occurrence(s) de ce NICAD ?\n` +
          "Annulable avec Ctrl+Z.",
      );
    },
    [tableRows, deleteRows],
  );

  // Mode édition doublons : réassigne un NICAD distinct à l'occurrence `index`
  // (résout la doublure sans supprimer). Localisée par emprise (précise), point ou
  // NICAD ; l'erreur DUPLICATE rattachée (`_errorId`) est marquée corrigée.
  const performRenameOccurrence = useCallback(
    async (index: number, newNicad: string) => {
      const row = tableRows[index];
      const target = newNicad.trim();
      if (!row || !target) return;
      const current = rowNicad(row);
      if (target === current) return;
      if (renamingRef.current) return;
      const locator = {
        point: Array.isArray(row._point)
          ? (row._point as [number, number])
          : undefined,
        bbox:
          Array.isArray(row._bbox) && row._bbox.length === 4
            ? (row._bbox as BBox)
            : undefined,
        nicad: current || undefined,
      };
      const errorId =
        typeof row._errorId === "number" ? row._errorId : undefined;
      renamingRef.current = true;
      try {
        const res = await fetch(
          `/api/analyses/${analysis.id}/features/update-nicad`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locator, nicad: target, errorId }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Réassignation échouée");
        const beforeSnapshot: MapSnapshot = {
          correctedGeoJson:
            data.previousCorrectedGeoJson ?? correctedData ?? "",
          errorPatches:
            errorId != null
              ? [{ errorId, corrected: correctedErrorIds.has(errorId) }]
              : [],
          tableRows,
          selectedRows: new Set(selectedRows),
          deletedNicads,
        };
        if (data.correctedGeoJson) setCorrectedData(data.correctedGeoJson);
        setTileVersion((v) => v + 1); // rafraîchit les tuiles (nouveau NICAD)
        if (errorId != null)
          setCorrectedErrorIds((prev) => new Set(prev).add(errorId));
        // Reflète le nouveau NICAD dans la table (l'occurrence sort du doublon).
        const renamed = tableRows.map((r, i) =>
          i === index ? withRowNicad(r, target) : r,
        );
        setTableRows(renamed);
        mapHistory.push({
          kind: "rename",
          before: beforeSnapshot,
          after: {
            correctedGeoJson:
              data.correctedGeoJson ?? beforeSnapshot.correctedGeoJson,
            errorPatches: errorId != null ? [{ errorId, corrected: true }] : [],
            tableRows: renamed,
            selectedRows: new Set(selectedRows),
            deletedNicads,
          },
        });
        toast.success(`NICAD réassigné : ${target}`);
      } catch (err) {
        toast.error(String(err));
      } finally {
        renamingRef.current = false;
      }
    },
    [
      tableRows,
      analysis.id,
      correctedData,
      correctedErrorIds,
      selectedRows,
      deletedNicads,
      mapHistory,
    ],
  );

  const handleRenameOccurrence = useCallback(
    (index: number, newNicad: string) => {
      const row = tableRows[index];
      const target = newNicad.trim();
      if (!row || !target) return;
      const current = rowNicad(row);
      if (target === current) return;
      setConfirmState({
        title: "Réassigner le NICAD",
        description: `Réassigner le NICAD de l'occurrence ${index + 1} : « ${current || "—"} » → « ${target} » ?`,
        confirmLabel: "Réassigner",
        run: () => void performRenameOccurrence(index, newNicad),
      });
    },
    [tableRows, performRenameOccurrence],
  );

  // Réapplique un instantané (avant ou après une édition) : ré-écrit le serveur
  // (correctedData + flags corrected fusionnés, jamais remplacés en bloc — un
  // instantané ne porte que les erreurs de SA propre action) puis l'affichage local.
  const applyMapSnapshot = useCallback(
    async (snap: MapSnapshot) => {
      const res = await fetch(`/api/analyses/${analysis.id}/history/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          correctedGeoJson: snap.correctedGeoJson,
          errorPatches: snap.errorPatches,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Restauration échouée");
      setCorrectedData(snap.correctedGeoJson);
      setTileVersion((v) => v + 1);
      setCorrectedErrorIds((prev) => {
        const next = new Set(prev);
        for (const p of snap.errorPatches) {
          if (p.corrected) next.add(p.errorId);
          else next.delete(p.errorId);
        }
        return next;
      });
      setTableRows(snap.tableRows);
      setSelectedRows(new Set(snap.selectedRows));
      setDeletedNicads(snap.deletedNicads);
    },
    [analysis.id],
  );

  const performUndo = useCallback(async () => {
    const entry = mapHistory.peekUndo();
    if (!entry || restoringHistory) return;
    setRestoringHistory(true);
    try {
      await applyMapSnapshot(entry.before);
      mapHistory.commitUndo();
      toast.success(
        entry.kind === "delete" ? "Suppression annulée" : "Renommage annulé",
      );
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRestoringHistory(false);
    }
  }, [mapHistory, restoringHistory, applyMapSnapshot]);
  useEffect(() => {
    performUndoRef.current = performUndo;
  }, [performUndo]);

  const performRedo = useCallback(async () => {
    const entry = mapHistory.peekRedo();
    if (!entry || restoringHistory) return;
    setRestoringHistory(true);
    try {
      await applyMapSnapshot(entry.after);
      mapHistory.commitRedo();
      toast.success(
        entry.kind === "delete" ? "Suppression rétablie" : "Renommage rétabli",
      );
    } catch (err) {
      toast.error(String(err));
    } finally {
      setRestoringHistory(false);
    }
  }, [mapHistory, restoringHistory, applyMapSnapshot]);

  useUndoRedoShortcuts(performUndo, performRedo);

  // NiCADs of all selected table rows (drives map highlight)
  const selectedNicads = useMemo(
    () =>
      tableRows
        .map((r) => String(r.NICAD ?? r.nicad ?? r.NIC ?? r.Nicad ?? ""))
        .filter(Boolean),
    [tableRows],
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
    if (rows.length > 0) {
      setTableRows(rows);
      setTableOpen(true);
    }
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
        clearDuplicateFocus();
        setFocusTarget({ nicad: query, key: Date.now() });
        setSearchedNicad(query);
        return;
      }
      toast.error("NICAD introuvable", {
        description: `Aucune parcelle trouvée pour "${query}"`,
      });
      return;
    }
    setSelectedError(null);
    clearDuplicateFocus();
    setSelectedParcel(feats[0]);
    setTableRows(
      feats.map((p, i) => ({
        _role: feats.length > 1 ? `Occurrence ${i + 1}` : "Résultat",
        ...p,
      })),
    );
    setTableOpen(true);
    setFocusTarget({ nicad: query, key: Date.now() });
    setSearchedNicad(query);
  }, [nicadSearch, nicadToAllFeatures, LARGE_DATASET, clearDuplicateFocus]);

  const handleResetSearch = useCallback(() => {
    setNicadSearch("");
    setSelectedParcel(null);
    setSelectedError(null);
    clearDuplicateFocus();
    setTableRows([]);
    setFocusTarget(null);
    setSearchedNicad(null);
  }, [clearDuplicateFocus]);

  const toggleFilter = (type: string) => {
    const next = new Set(activeFilters);
    if (next.has(type)) next.delete(type);
    else next.add(type);
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
          parcelleContext: selectedParcel
            ? {
                nicad: selectedParcel.NICAD || selectedParcel.nicad,
                properties: selectedParcel,
              }
            : undefined,
          conversationHistory: chatMessages,
        }),
      });
      const data = await res.json();
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.message },
      ]);
    } catch (err) {
      toast.error("Erreur IA", { description: String(err) });
    } finally {
      setChatLoading(false);
    }
  };

  const handleCorrectError = useCallback(
    async (
      errorId: number,
      action: string,
      targetNicad?: string,
      targetSection?: string,
    ) => {
      setCorrectingErrorId(errorId);
      try {
        const res = await fetch(
          `/api/analyses/${analysis.id}/errors/${errorId}/correct`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, targetNicad, targetSection }),
          },
        );
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Erreur lors de la correction");
        if (data.correctedGeoJson) setCorrectedData(data.correctedGeoJson);
        // Invalide le cache des tuiles vectorielles (la carte reflète la correction).
        setTileVersion((v) => v + 1);
        setCorrectedErrorIds((prev) => new Set(prev).add(errorId));
        if (data.stats) setStatsOverride(data.stats);
        toast.success("Correction appliquée", { description: data.message });
        setSelectedError(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setCorrectingErrorId(null);
      }
    },
    [analysis.id],
  );

  // ── Attribution en masse des NICAD manquants sur CETTE analyse ─────────────
  // Contrairement à l'assignation manuelle par erreur (ci-dessus, `AUTO_xxxxxx`
  // factice), réutilise le vrai schéma NICAD et le chaînage plus proche voisin
  // de `nicad-fill-missing.ts`, sur toutes les sections numérotées qui
  // couvrent cette analyse — même flux aperçu/confirmation que
  // `/cadastre/sections` (cf. `SectionsClient.tsx`).
  const refreshCorrectedErrorsFromServer = useCallback(async () => {
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/errors`);
      if (!res.ok) return;
      const fresh = (await res.json()) as { id: number; corrected: boolean }[];
      const newlyCorrected = fresh.filter((e) => e.corrected).map((e) => e.id);
      if (newlyCorrected.length > 0) {
        setCorrectedErrorIds((prev) => new Set([...prev, ...newlyCorrected]));
      }
    } catch {
      /* rafraîchissement best-effort */
    }
  }, [analysis.id]);

  const performFillMissingNicad = useCallback(
    async (sections: string[]) => {
      setFillingNicad(true);
      try {
        const res = await fetch(`/api/analyses/${analysis.id}/nicad-fill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sections }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Attribution échouée");
        const result = data.result as {
          parcelsAssigned: number;
          unresolvedCount: number;
          plans: {
            numSection: string;
            count: number;
            fromParcelle: string;
            toParcelle: string;
            viaCommune2026?: boolean;
            communeApprox?: boolean;
            crossFileSection?: boolean;
            sectionSourceFichier?: string;
          }[];
        };
        if (result.parcelsAssigned === 0) {
          toast.info("Aucune parcelle n'a pu être numérotée.");
          return;
        }
        const range =
          result.plans.length === 1
            ? ` (section ${result.plans[0].numSection} : ${result.plans[0].fromParcelle} → ${result.plans[0].toParcelle})`
            : ` (${result.plans.length} section(s) concernée(s))`;
        toast.success(`${result.parcelsAssigned} NICAD attribué(s)${range}.`);
        if (result.unresolvedCount > 0) {
          toast.warning(
            `${result.unresolvedCount} parcelle(s) sans NICAD non traitée(s) (aucune parcelle déjà numérotée dans leur section pour servir de référence).`,
          );
        }
        if (result.plans.some((p) => p.viaCommune2026)) {
          toast.warning(
            result.plans.some((p) => p.communeApprox)
              ? "Préfixe territorial déduit de la commune 2026 par proximité pour au moins une section (aucune parcelle de référence disponible) — à vérifier."
              : "Préfixe territorial déduit de la commune 2026 pour au moins une section (aucune parcelle de référence disponible) — à vérifier.",
          );
        }
        if (result.plans.some((p) => p.crossFileSection)) {
          toast.warning(
            "Section trouvée dans un autre fichier importé que cette analyse (limites cadastrales existantes réutilisées par géométrie) — à vérifier.",
          );
        }
        setTileVersion((v) => v + 1);
        void refreshCorrectedErrorsFromServer();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setFillingNicad(false);
      }
    },
    [analysis.id, refreshCorrectedErrorsFromServer],
  );

  // Aperçu (dryRun, toutes sections) qui alimente le sélecteur de sections
  // (`nicadFillPreview`/`nicadFillSelection`, rendu près de `<ConfirmDialog>`) :
  // contrairement à `confirmState` (description figée à l'ouverture), ces cases
  // à cocher doivent rester interactives — la liste est donc construite en
  // JSX inline au point de rendu, à partir d'un state dédié qui se met à jour
  // à chaque clic, plutôt que via une description React figée dans `confirmState`.
  const handleFillMissingNicad = useCallback(async () => {
    setFillingNicad(true);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/nicad-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Aperçu échoué");
      const result = data.result as {
        parcelsAssigned: number;
        unresolvedCount: number;
        plans: {
          numSection: string;
          count: number;
          fromParcelle: string;
          toParcelle: string;
          viaCommune2026?: boolean;
          communeApprox?: boolean;
          crossFileSection?: boolean;
          sectionSourceFichier?: string;
        }[];
      };
      if (result.parcelsAssigned === 0) {
        toast.info(
          result.unresolvedCount > 0
            ? `${result.unresolvedCount} parcelle(s) sans NICAD, mais aucune parcelle déjà numérotée dans leur section pour servir de référence.`
            : "Aucune parcelle sans NICAD dans les sections numérotées de cette analyse.",
        );
        return;
      }
      setNicadFillPreview({
        plans: result.plans,
        unresolvedCount: result.unresolvedCount,
      });
      setNicadFillSelection(new Set(result.plans.map((p) => p.numSection)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setFillingNicad(false);
    }
  }, [analysis.id]);

  const handleSaveReport = async () => {
    setIsSavingReport(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId: analysis.id,
          reportType: "DETAILED",
        }),
      });
      if (!res.ok) throw new Error("Erreur lors de la sauvegarde");
      toast.success("Rapport sauvegardé", {
        description: "Consultez la page Rapports pour le télécharger.",
      });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsSavingReport(false);
    }
  };

  const handleRegenerateReport = async () => {
    setIsRegeneratingReport(true);
    try {
      const res = await fetch(
        `/api/analyses/${analysis.id}/regenerate-report`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "Erreur lors de la génération");
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
      const res = await fetch(`/api/analyses/${analysis.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "Erreur lors de la suppression");
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
    if (!correctedData) {
      toast.error("Aucune correction disponible");
      return;
    }
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
        <div
          className={`border-border flex flex-col bg-card shrink-0 overflow-hidden transition-[width,border-width] duration-300 ease-in-out ${
            leftPanelOpen ? "w-96 border-r" : "w-0 border-r-0"
          }`}
        >
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold truncate">
                {analysis.fileName}
              </h2>
              <Badge
                variant={displayConformityScore >= 70 ? "default" : "destructive"}
                className="text-xs shrink-0 ml-2"
              >
                {displayConformityScore.toFixed(0)}%
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {(analysis.totalFeatures ?? 0).toLocaleString()} parcelles
              </span>
              <span>·</span>
              <span
                className="text-green-400"
                title="Parcelles sans erreur topologique"
              >
                {displayConformeCount != null
                  ? displayConformeCount.toLocaleString()
                  : "…"}{" "}
                conformes
              </span>
              <span>·</span>
              <span className="text-red-400">{displayErrorCount} erreurs</span>
              {(analysis.outOfSenegalCount ?? 0) > 0 && (
                <>
                  <span>·</span>
                  <span
                    className="text-amber-400"
                    title="Entités hors des limites du Sénégal, écartées de l'affichage"
                  >
                    {analysis.outOfSenegalCount} hors Sénégal
                  </span>
                </>
              )}
              {(analysis.commune || analysis.region) && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {[analysis.commune, analysis.region]
                      .filter(Boolean)
                      .join(", ")}
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSearchNicad();
                    }
                  }}
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
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={handleSearchNicad}
                disabled={!nicadSearch.trim()}
              >
                Chercher
              </Button>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                variant={showSections ? "default" : "outline"}
                className="gap-1.5 flex-1 h-8 text-xs"
                onClick={() => setShowSections((v) => !v)}
                title="Afficher les limites de sections et leurs numéros sur la carte"
              >
                <Layers className="w-3 h-3" />
                Sections
              </Button>
              <Button
                size="sm"
                variant={showSansSection ? "default" : "outline"}
                className="gap-1.5 flex-1 h-8 text-xs"
                onClick={() => setShowSansSection((v) => !v)}
                title="Colorer en orange les parcelles sans section rattachée (composante section du NICAD indéterminée)"
              >
                <AlertTriangle
                  className="w-3 h-3"
                  style={{ color: showSansSection ? undefined : "#f97316" }}
                />
                Sans section
                {sansSectionCount != null
                  ? ` (${sansSectionCount.toLocaleString("fr-FR")})`
                  : ""}
              </Button>
              {correctedData && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 flex-1 h-8 text-xs"
                  onClick={handleDownloadCorrected}
                >
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

            {/* Attribution en masse des NICAD manquants (incrémentation + plus
                proche voisin, par section numérotée de cette analyse). */}
            <div className="flex mt-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 flex-1 h-8 text-xs"
                onClick={() => void handleFillMissingNicad()}
                disabled={fillingNicad}
                title="Attribuer un NICAD aux parcelles sans NICAD de cette analyse (incrémentation + plus proche voisin, par section numérotée)"
              >
                {fillingNicad ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Wrench className="w-3 h-3" />
                )}
                Attribuer les NICAD manquants
              </Button>
            </div>

            {/* Limites administratives (référentiel national, mêmes contours que /cadastre/sections) */}
            <div className="flex mt-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={
                      ADMIN_LEVELS.some((level) => adminShow[level])
                        ? "default"
                        : "outline"
                    }
                    className="gap-1.5 flex-1 h-8 text-xs"
                  >
                    <Layers className="w-3 h-3" />
                    Limites admin
                    {ADMIN_LEVELS.some((level) => adminShow[level])
                      ? ` (${ADMIN_LEVELS.filter((level) => adminShow[level])
                          .map((level) => ADMIN_STYLES[level].label)
                          .join(", ")})`
                      : ""}
                    <ChevronDown className="w-3 h-3 opacity-60" />
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
            </div>
          </div>

          <Tabs
            defaultValue="errors"
            className="flex-1 flex flex-col overflow-hidden"
          >
            <div className="mx-4 mt-3 shrink-0 flex items-center gap-2">
              <TabsList className="flex-1 grid grid-cols-4">
                <TabsTrigger value="errors" className="text-xs px-1">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  Erreurs
                </TabsTrigger>
                <TabsTrigger
                  value="duplicates"
                  className="text-xs px-1 relative"
                >
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
              <Link
                href={`/map/${analysis.id}/table`}
                title="Voir les données en table"
              >
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 shrink-0"
                >
                  <Table2 className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>

            {/* Errors tab */}
            <TabsContent
              value="errors"
              className="flex-1 overflow-hidden flex flex-col px-4 mt-3"
            >
              {/* Type filters */}
              <div className="flex flex-wrap gap-1 mb-3">
                {errorTypeGroups.map((type) => {
                  const count = analysis.errors.filter(
                    (e) => e.errorType === type,
                  ).length;
                  const active = activeFilters.has(type);
                  return (
                    <button
                      key={type}
                      onClick={() => toggleFilter(type)}
                      className={`cursor-pointer text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full inline-block mr-1"
                        style={{ background: errorTypeColor(type) }}
                      />
                      {type} ({count})
                    </button>
                  );
                })}
              </div>

              {filteredErrors.length > 0 && (
                <p className="text-[11px] text-muted-foreground mb-2 leading-relaxed">
                  👉 Cliquez sur une erreur ci-dessous (ou sur une parcelle de
                  la carte) pour la localiser, puis choisissez une action de
                  correction dans le panneau qui s&apos;ouvre en bas.
                </p>
              )}
              <ScrollArea className="flex-1">
                <div className="space-y-1.5 pb-4">
                  {filteredErrors.map((err) => (
                    <button
                      key={err.id}
                      onClick={() => {
                        setSelectedDupNicad(null);
                        setSelectedError(
                          selectedError?.id === err.id ? null : err,
                        );
                      }}
                      className={`cursor-pointer w-full text-left p-3 rounded-lg border transition-all ${
                        selectedError?.id === err.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/30"
                      } ${err.corrected || correctedErrorIds.has(err.id) ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: errorTypeColor(err.errorType) }}
                        />
                        <span className="text-[10px] font-mono">
                          {err.errorType}
                        </span>
                        <Badge
                          variant={
                            err.severity.toLowerCase() as
                              | "critical"
                              | "high"
                              | "medium"
                              | "low"
                          }
                          className="text-[9px] h-4 px-1 ml-auto"
                        >
                          {SEVERITY_LABELS[err.severity] || err.severity}
                        </Badge>
                      </div>
                      {err.nicad1 && (
                        <p className="text-xs font-mono text-muted-foreground truncate">
                          {err.nicad1}
                          {err.nicad2 ? ` ↔ ${err.nicad2}` : ""}
                        </p>
                      )}
                      {err.area && (
                        <p className="text-[10px] text-muted-foreground">
                          {err.area.toFixed(2)} m²
                        </p>
                      )}
                    </button>
                  ))}
                  {filteredErrors.length === 0 && (
                    <div className="text-center py-8">
                      <CheckCircle className="w-8 h-8 text-green-400 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">
                        Aucune erreur
                      </p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Duplicates tab */}
            <TabsContent
              value="duplicates"
              className="flex-1 overflow-hidden flex flex-col px-4 mt-3"
            >
              {duplicateGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-2">
                  <CheckCircle className="w-8 h-8 text-green-400 opacity-70" />
                  <p className="text-sm text-muted-foreground">
                    Aucun doublon détecté
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2 mb-3 shrink-0">
                    <p className="text-[11px] text-muted-foreground flex-1">
                      <span className="font-semibold text-purple-400">
                        {duplicateGroups.length}
                      </span>{" "}
                      NICAD
                      {duplicateGroups.length > 1 ? "s" : ""} dupliqué
                      {duplicateGroups.length > 1 ? "s" : ""}
                      {" · "}cliquer un groupe zoome sur ses occurrences et les
                      annote
                      {dupEditMode && (
                        <span className="block text-green-400/80 mt-0.5">
                          Mode édition (table) : <strong>Renommer</strong>{" "}
                          réassigne un NICAD distinct à l&apos;occurrence,{" "}
                          <strong>Conserver</strong> (ou un clic sur son
                          marqueur) la garde et supprime les autres.
                        </span>
                      )}
                    </p>
                    <Button
                      size="sm"
                      variant={dupEditMode ? "default" : "outline"}
                      className="h-6 px-2 text-[10px] gap-1 shrink-0"
                      onClick={() => setDupEditMode((v) => !v)}
                      title="Activer l'édition des doublures : conserver une occurrence et supprimer les autres"
                    >
                      <Wrench className="w-3 h-3" />
                      {dupEditMode ? "Édition ON" : "Éditer"}
                    </Button>
                  </div>
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
                                <div
                                  key={err.id}
                                  className="flex items-center gap-2 text-[10px] text-muted-foreground"
                                >
                                  <span className="font-mono text-purple-400/70">
                                    #{i + 1}
                                  </span>
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
                                ✓ Occurrences surlignées sur la carte ·
                                Comparaison ouverte
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
            <TabsContent
              value="report"
              className="flex-1 overflow-hidden flex flex-col px-4 mt-3"
            >
              <div className="flex gap-2 mb-3 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-7 text-xs"
                  onClick={handleRegenerateReport}
                  disabled={isRegeneratingReport}
                  title="Régénérer le rapport IA"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isRegeneratingReport ? "animate-spin" : ""}`}
                  />
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1"
                      >
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
                    <p className="text-xs text-muted-foreground">
                      Génération du rapport en cours…
                    </p>
                  </div>
                ) : aiReport ? (
                  <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed">
                    <ReactMarkdown>{aiReport}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                    <p className="text-sm text-muted-foreground">
                      Rapport non disponible
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Cliquez sur &quot;Régénérer&quot; pour créer un rapport IA
                    </p>
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* Chat tab */}
            <TabsContent
              value="chat"
              className="flex-1 flex flex-col overflow-hidden px-4 mt-3"
            >
              <ScrollArea className="flex-1 mb-3">
                <div className="space-y-3 pb-2">
                  {chatMessages.length === 0 && (
                    <div className="text-center py-6">
                      <Brain className="w-8 h-8 text-primary mx-auto mb-2 opacity-50" />
                      <p className="text-xs text-muted-foreground">
                        Posez une question sur vos données cadastrales
                      </p>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] px-3 py-2 rounded-lg text-xs ${
                          msg.role === "user"
                            ? "bg-primary/10 text-primary border border-primary/20"
                            : "bg-secondary border border-border"
                        }`}
                      >
                        {msg.role === "assistant" ? (
                          <div className="prose prose-invert prose-xs max-w-none">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        ) : (
                          msg.content
                        )}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex justify-start">
                      <div className="px-3 py-2 rounded-lg bg-secondary border border-border">
                        <div className="flex gap-1">
                          {[0, 1, 2].map((i) => (
                            <div
                              key={i}
                              className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                              style={{ animationDelay: `${i * 0.15}s` }}
                            />
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
                    Parcelle:{" "}
                    {String(
                      selectedParcel.NICAD || selectedParcel.nicad || "N/A",
                    )}
                  </span>
                  <button
                    className="cursor-pointer"
                    onClick={() => setSelectedParcel(null)}
                  >
                    <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleChat();
                    }
                  }}
                  placeholder="Ex: Quelles sont les erreurs critiques ?"
                  className="flex-1 text-xs px-3 py-2 rounded-lg border border-border bg-transparent focus:outline-none focus:ring-1 focus:ring-primary"
                  disabled={chatLoading}
                />
                <Button
                  size="sm"
                  onClick={handleChat}
                  disabled={chatLoading || !chatInput.trim()}
                  className="h-9 px-3"
                >
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
                <button
                  className="cursor-pointer"
                  onClick={() => setSelectedError(null)}
                >
                  <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  <strong className="text-foreground">Type:</strong>{" "}
                  {selectedError.errorType}
                </p>
                <p>
                  <strong className="text-foreground">Sévérité:</strong>{" "}
                  {SEVERITY_LABELS[selectedError.severity]}
                </p>
                {selectedError.nicad1 && (
                  <p>
                    <strong className="text-foreground">NICAD:</strong>{" "}
                    {selectedError.nicad1}
                  </p>
                )}
                {selectedError.area && (
                  <p>
                    <strong className="text-foreground">Surface:</strong>{" "}
                    {selectedError.area.toFixed(2)} m²
                  </p>
                )}
                {selectedError.description && (
                  <p className="mt-1 leading-relaxed">
                    {selectedError.description}
                  </p>
                )}
              </div>

              {selectedError.corrected ||
              correctedErrorIds.has(selectedError.id) ? (
                <p className="mt-3 pt-3 border-t border-border/50 text-[11px] text-green-400 flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5" /> Erreur corrigée
                </p>
              ) : (
                <div className="mt-3 pt-3 border-t border-border/50 space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Corriger
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed pb-1">
                    Choisissez une action pour appliquer la correction. Elle est
                    exécutée immédiatement et le résultat est téléchargeable via
                    le bouton <strong>« Télécharger »</strong>.
                  </p>
                  {selectedError.errorType === "OVERLAP" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() =>
                          handleCorrectError(selectedError.id, "clip_first")
                        }
                      >
                        <Wrench className="w-3 h-3" /> Découper{" "}
                        {selectedError.nicad1 ?? "parcelle 1"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() =>
                          handleCorrectError(selectedError.id, "clip_second")
                        }
                      >
                        <Wrench className="w-3 h-3" /> Découper{" "}
                        {selectedError.nicad2 ?? "parcelle 2"}
                      </Button>
                    </>
                  )}
                  {selectedError.errorType === "SLIVER" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() =>
                          handleCorrectError(selectedError.id, "merge_neighbor")
                        }
                      >
                        <Wrench className="w-3 h-3" /> Fusionner avec la
                        parcelle voisine
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full h-7 text-xs justify-start gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() =>
                          handleCorrectError(selectedError.id, "delete")
                        }
                      >
                        <Trash2 className="w-3 h-3" /> Supprimer le sliver
                      </Button>
                    </>
                  )}
                  {selectedError.errorType === "GAP" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() =>
                        handleCorrectError(
                          selectedError.id,
                          "assign_to_neighbor",
                        )
                      }
                    >
                      <Wrench className="w-3 h-3" /> Combler avec{" "}
                      {selectedError.nicad1 ?? "la parcelle adjacente"}
                    </Button>
                  )}
                  {selectedError.errorType === "BOUNDARY_CROSS" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() =>
                        handleCorrectError(selectedError.id, "truncate")
                      }
                    >
                      <Wrench className="w-3 h-3" /> Tronquer à la limite
                      administrative
                    </Button>
                  )}
                  {selectedError.errorType === "INVALID_GEOM" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() =>
                        handleCorrectError(selectedError.id, "delete")
                      }
                    >
                      <Trash2 className="w-3 h-3" /> Supprimer la géométrie
                      invalide
                    </Button>
                  )}
                  {selectedError.errorType === "DUPLICATE" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs justify-start gap-1.5"
                      disabled={correctingErrorId === selectedError.id}
                      onClick={() =>
                        handleCorrectError(selectedError.id, "delete")
                      }
                    >
                      <Trash2 className="w-3 h-3" /> Supprimer cette occurrence
                      du doublon
                    </Button>
                  )}
                  {(selectedError.errorType === "MISSING_NICAD" ||
                    selectedError.errorType === "SHORT_NICAD") && (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={nicadAssignValue}
                        onChange={(e) => setNicadAssignValue(e.target.value)}
                        placeholder={
                          selectedError.errorType === "SHORT_NICAD"
                            ? "NICAD corrigé (vide = AUTO)"
                            : "NICAD (vide = AUTO)"
                        }
                        className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => {
                          handleCorrectError(
                            selectedError.id,
                            "assign_nicad",
                            nicadAssignValue.trim() || undefined,
                          );
                          setNicadAssignValue("");
                        }}
                      >
                        <Wrench className="w-3 h-3" /> Assigner
                      </Button>
                    </div>
                  )}
                  {selectedError.errorType === "SECTION_MISMATCH" && (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={sectionAssignValue}
                        onChange={(e) => setSectionAssignValue(e.target.value)}
                        placeholder="Section (vide = section géolocalisée)"
                        className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1.5"
                        disabled={correctingErrorId === selectedError.id}
                        onClick={() => {
                          handleCorrectError(
                            selectedError.id,
                            "assign_section",
                            undefined,
                            sectionAssignValue.trim() || undefined,
                          );
                          setSectionAssignValue("");
                        }}
                      >
                        <Wrench className="w-3 h-3" /> Assigner
                      </Button>
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full h-7 text-xs justify-start gap-1.5 text-muted-foreground"
                    disabled={correctingErrorId === selectedError.id}
                    onClick={() =>
                      handleCorrectError(selectedError.id, "ignore")
                    }
                  >
                    <X className="w-3 h-3" /> Ignorer (intentionnel)
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bascule d'affichage du panneau latéral. */}
        <button
          onClick={() => setLeftPanelOpen((v) => !v)}
          title={
            leftPanelOpen
              ? "Masquer le panneau latéral"
              : "Afficher le panneau latéral"
          }
          className="shrink-0 w-4 flex items-center justify-center border-r border-border bg-card hover:bg-secondary/60 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        >
          <ChevronLeft
            className={`w-3 h-3 transition-transform ${leftPanelOpen ? "" : "rotate-180"}`}
          />
        </button>

        {/* Map + Attribute Table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 relative min-h-0">
            <MapLibreMap
              analysisId={analysis.id}
              tilesVersion={tileVersion}
              initialBounds={initialBounds}
              errors={mapErrors}
              selectedErrorId={selectedError?.id}
              blinkIntense={
                (selectedError?.errorType ?? "").toUpperCase() === "DUPLICATE"
              }
              onFeatureClick={handleFeatureClick}
              selectedNicads={selectedNicads}
              focusTarget={focusTarget}
              searchedNicads={searchedNicad ? [searchedNicad] : []}
              // Parcelles intactes (conformes) toujours affichées en vert : erreurs
              // colorées par type (couleurs de l'accueil) + intactes en vert.
              conformeHighlight={true}
              nonConformeNicads={nonConformeNicads}
              occurrences={dupOccurrences}
              occurrencesBounds={dupBounds}
              occurrenceEditMode={dupEditMode && !!selectedDupNicad}
              onOccurrenceKeep={handleKeepOnlyOccurrence}
              showSections={showSections}
              sansSectionHighlight={showSansSection}
              deletedNicads={deletedNicads}
              adminLevels={ADMIN_LEVELS.filter((level) => adminShow[level])}
            />
            {/* Annuler/rétablir — coin haut-gauche de la carte, sur la même
                ligne que le panneau latéral, juste à sa droite. */}
            <div className="absolute top-2 left-2 z-10 flex items-center gap-1 px-1.5 py-1 rounded-lg border border-border bg-card/90 backdrop-blur-sm shadow-lg">
              <button
                onClick={() => void performUndo()}
                disabled={!mapHistory.canUndo || restoringHistory}
                title="Annuler (Ctrl+Z)"
                className="flex items-center gap-1 px-1.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => void performRedo()}
                disabled={!mapHistory.canRedo || restoringHistory}
                title="Rétablir (Ctrl+Y)"
                className="flex items-center gap-1 px-1.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
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
              {tableOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronUp className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Attribute table panel */}
          {tableOpen && (
            <div
              className="border-t border-border bg-card shrink-0 flex flex-col"
              style={{ height: 210 }}
            >
              {/* Header bar */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <Table2 className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs font-semibold">
                    Table attributaire
                  </span>
                  {tableRows.length > 0 && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-2">
                      <span>
                        {tableRows.length} parcelle
                        {tableRows.length > 1 ? "s" : ""}
                        {selectedDupNicad
                          ? ` — doublon NICAD ${selectedDupNicad}`
                          : selectedError
                            ? ` — ${selectedError.errorType}`
                            : ""}
                      </span>
                      {tableRows.length >= 2 && (
                        <span className="text-yellow-400">
                          · différences surlignées
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setTableRows([]);
                          setSelectedParcel(null);
                          setSelectedRows(new Set());
                          clearDuplicateFocus();
                        }}
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
                      <Trash2
                        className={`w-3 h-3 ${deletingRows ? "animate-spin" : ""}`}
                      />
                      {deletingRows
                        ? "Suppression…"
                        : `Supprimer${selectedRows.size ? ` (${selectedRows.size})` : " les parcelles"}`}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setTableOpen(false);
                      setTableRows([]);
                      setSelectedRows(new Set());
                      clearDuplicateFocus();
                    }}
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
                    Cliquez une parcelle ou sélectionnez une erreur dans la
                    liste
                  </div>
                ) : (
                  <AttributeTable
                    rows={tableRows}
                    selectable={tableDeletable}
                    selectedKeys={selectedRows}
                    onToggle={toggleRow}
                    onToggleAll={toggleAllRows}
                    editMode={dupEditMode && !!selectedDupNicad}
                    onKeepOnly={handleKeepOnlyOccurrence}
                    onRename={handleRenameOccurrence}
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
                <h2 className="text-base font-semibold">
                  Supprimer l&apos;analyse
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Cette action est irréversible.
                </p>
              </div>
            </div>

            {/* What will be deleted */}
            <div className="rounded-lg border border-border bg-secondary/30 p-4 mb-5 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Données supprimées
              </p>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Fichier</span>
                <span className="font-mono text-xs truncate max-w-[200px]">
                  {analysis.fileName}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Parcelles</span>
                <span className="font-semibold">
                  {(analysis.totalFeatures ?? 0).toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Erreurs détectées</span>
                <span className="font-semibold text-red-400">
                  {analysis.errors.length}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Fichier GeoJSON sur disque
                </span>
                <span className="text-orange-400 text-xs">
                  Supprimé définitivement
                </span>
              </div>
              {correctedData && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Données corrigées
                  </span>
                  <span className="text-orange-400 text-xs">
                    Supprimées définitivement
                  </span>
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
      <ConfirmDialog
        open={nicadFillPreview !== null}
        title="Attribuer les NICAD manquants"
        confirmLabel="Attribuer"
        description={
          nicadFillPreview && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p>Sections à traiter :</p>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline cursor-pointer"
                  onClick={() =>
                    setNicadFillSelection((prev) =>
                      prev.size ===
                      new Set(nicadFillPreview.plans.map((p) => p.numSection))
                        .size
                        ? new Set()
                        : new Set(
                            nicadFillPreview.plans.map((p) => p.numSection),
                          ),
                    )
                  }
                >
                  {nicadFillSelection.size ===
                  new Set(nicadFillPreview.plans.map((p) => p.numSection)).size
                    ? "Tout désélectionner"
                    : "Tout sélectionner"}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {nicadFillPreview.plans.map((p, i) => (
                  <label
                    key={`${p.numSection}-${p.sectionSourceFichier ?? ""}-${i}`}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/40"
                  >
                    <input
                      type="checkbox"
                      checked={nicadFillSelection.has(p.numSection)}
                      onChange={() =>
                        setNicadFillSelection((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.numSection)) next.delete(p.numSection);
                          else next.add(p.numSection);
                          return next;
                        })
                      }
                    />
                    <span className="flex-1">
                      Section {p.numSection} — {p.count} ({p.fromParcelle} →{" "}
                      {p.toParcelle})
                      {p.viaCommune2026 && (
                        <span
                          className="ml-1 text-amber-600"
                          title={
                            p.communeApprox
                              ? "Aucune parcelle de référence dans la section : préfixe déduit de la commune 2026 par proximité — à vérifier."
                              : "Aucune parcelle de référence dans la section : préfixe déduit de la commune 2026 — à vérifier."
                          }
                        >
                          ⚠ commune 2026{p.communeApprox ? " (approx.)" : ""}
                        </span>
                      )}
                      {p.crossFileSection && (
                        <span
                          className="ml-1 text-amber-600"
                          title={`Section absente de cette analyse : reprise par géométrie depuis ${p.sectionSourceFichier ?? "un autre fichier"} — à vérifier.`}
                        >
                          ⚠ autre fichier
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Numérotation par plus proche voisin à partir du dernier numéro
                connu de chaque section sélectionnée.
                {nicadFillPreview.unresolvedCount > 0 &&
                  ` ${nicadFillPreview.unresolvedCount} parcelle(s) sans NICAD non traitable(s) (aucune référence dans leur section, ni commune 2026 correspondante).`}
              </p>
            </div>
          )
        }
        onConfirm={() => {
          const sections = Array.from(nicadFillSelection);
          setNicadFillPreview(null);
          if (sections.length === 0) {
            toast.error("Aucune section sélectionnée.");
            return;
          }
          void performFillMissingNicad(sections);
        }}
        onCancel={() => setNicadFillPreview(null)}
      />
    </div>
  );
}
