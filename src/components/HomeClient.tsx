"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload,
  MapPin,
  Brain,
  Shield,
  FileText,
  Activity,
  Layers,
  CheckCircle,
  Globe,
  Database,
  ArrowRight,
  BarChart2,
  History,
  ChevronRight,
  TrendingUp,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/components/NavBar";
import DxfPipelineSection from "@/components/home/DxfPipelineSection";
import LayerMappingModal, {
  type LayerInventoryEntry,
} from "@/components/LayerMappingModal";
import FieldMappingModal from "@/components/FieldMappingModal";
import {
  JobProgressSteps,
  type JobProgressStep,
} from "@/components/import/JobProgressSteps";
import type { TargetFieldDef } from "@/lib/import/field-mapping";
import { toNum } from "@/lib/utils";

interface LayerInventory {
  fileKey: string;
  fileName: string;
  sourceType: "DXF" | "DGN";
  layers: LayerInventoryEntry[];
}

interface ShapefileFieldInventory {
  fileKey: string;
  fileName: string;
  fields: { name: string; sampleValues: string[] }[];
  targetFields: TargetFieldDef[];
  proposedMapping: Record<string, string>;
}

// const FORMATS = ["SHP", "GeoJSON", "DGN v7", "DXF", "KML", "CSV"];
const FORMATS = ["SHP", "GeoJSON", "DXF"];

const FEATURES = [
  {
    icon: Brain,
    title: "Analyse assistée par IA",
    desc: "Rapports d'analyse structurés, générés à partir des résultats des contrôles topologiques",
    color: "oklch(0.65 0.18 220)",
  },
  {
    icon: Layers,
    title: "Détection Topologique",
    desc: "Chevauchements, slivers, gaps, doublons NICAD — détectés avec précision mathématique",
    color: "oklch(0.60 0.22 25)",
  },
  {
    icon: MapPin,
    title: "Carte Interactive",
    desc: "Visualisation en temps réel des erreurs sur carte avec couches dynamiques",
    color: "oklch(0.70 0.18 140)",
  },
  {
    icon: Shield,
    title: "Limites Administratives",
    desc: "Validation automatique contre les 14 régions du Sénégal",
    color: "oklch(0.65 0.20 300)",
  },
  {
    icon: FileText,
    title: "Rapports PDF",
    desc: "Rapports d'expert complets avec cartes annotées et recommandations correctives",
    color: "oklch(0.70 0.18 55)",
  },
  {
    icon: Wrench,
    title: "Correction Automatique",
    desc: "Génère un GeoJSON corrigé (doublons supprimés, NICAD assignés, géométries invalides retirées)",
    color: "oklch(0.65 0.22 145)",
  },
];

const ERROR_TYPES = [
  { label: "Chevauchements", sublabel: "Overlaps", color: "#ef4444" },
  { label: "Espaces vides", sublabel: "Gaps", color: "#f59e0b" },
  { label: "Résidus", sublabel: "Slivers", color: "#a855f7" },
  { label: "Doublons NICAD", sublabel: "Duplicates", color: "#3b82f6" },
  { label: "Géom. invalides", sublabel: "Invalid Geom.", color: "#ec4899" },
  {
    label: "Croisements limites",
    sublabel: "Boundary Cross",
    color: "#06b6d4",
  },
];

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  stats: {
    totalAnalyses: number;
    totalParcelles: number;
    avgConformity: number;
  };
}

type UploadStep = "reading" | "analyzing" | "ai" | "done" | null;
// "analyze" : flux historique (topologie + rapport IA → /map/[id]).
// "import"  : gros fichiers CAO (DXF/DGN) → job d'import asynchrone vers
//             cad_parcelles (PostGIS), sondé par progression (Phase 1).
type UploadMode = "analyze" | "import";

interface AnalysisResult {
  id: number;
  totalFeatures: number;
  errorCount: number;
  conformityScore: number;
}

/** Pipeline job kind "parcelles" DXF/DGN (`run-job.ts`) : 4 phases jusqu'à l'analyse. */
const DXF_PIPELINE_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "build", label: "Construction des parcelles" },
  { key: "nicad", label: "Résolution des NICAD" },
  { key: "analyze", label: "Analyse topologique" },
];

/** Pipeline job kind "parcelles" shapefile (`run-shapefile-job.ts`) : pas d'étape NICAD/build distincte. */
const SHP_PARCELLES_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "analyze", label: "Analyse topologique" },
];

export default function HomeClient({ user, stats }: Props) {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(
    null,
  );
  const [mode, setMode] = useState<UploadMode>("analyze");
  const [jobPhase, setJobPhase] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState(0);
  const [jobSteps, setJobSteps] =
    useState<JobProgressStep[]>(DXF_PIPELINE_STEPS);
  // Inventaire des calques en attente de validation (variante « simple »).
  const [pendingInventory, setPendingInventory] =
    useState<LayerInventory | null>(null);
  // Inventaire des champs .dbf en attente de validation (shapefile page d'accueil).
  const [pendingFieldInventory, setPendingFieldInventory] =
    useState<ShapefileFieldInventory | null>(null);
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);

  const resetUpload = useCallback(() => {
    setIsUploading(false);
    setUploadStep(null);
    setAnalysisResult(null);
    setUploadFileName(null);
    setMode("analyze");
    setJobPhase(null);
    setJobProgress(0);
    setJobSteps(DXF_PIPELINE_STEPS);
    setPendingInventory(null);
    setPendingFieldInventory(null);
    setCurrentJobId(null);
  }, []);

  /**
   * Import asynchrone d'un fichier CAO volumineux (DXF/DGN) : démarre un job
   * (`POST /api/import-jobs`) puis sonde son avancement
   * (`GET /api/import-jobs/[id]`) jusqu'à `completed`/`failed`. Les parcelles
   * sont persistées dans cad_parcelles (pas de gros GeoJSON renvoyé au
   * navigateur), d'où la consultation finale sur la carte cadastrale.
   */
  /** Sonde l'avancement d'un job d'import jusqu'à `completed`/`failed`. */
  const pollImportJob = useCallback(async (jobId: number) => {
    setCurrentJobId(jobId);
    const startedAt = Date.now();
    // Garde-fou côté NAVIGATEUR uniquement : le job continue de tourner
    // côté serveur (`after()`, cf. import-jobs/route.ts) même après ce délai —
    // ce timeout arrête juste le SONDAGE, il n'annule rien. 60 min (pas 20) :
    // un DXF cadastral volumineux (100k+ parcelles) avec deux jointures
    // spatiales pour le NICAD (Syscol + section, cf. assign-nicad-2026.ts § 21)
    // peut légitimement dépasser 20 min — l'analyse apparaît alors dans
    // /history une fois le job terminé, même si cet onglet a abandonné le suivi.
    const TIMEOUT_MS = 60 * 60 * 1000;
    let netErrors = 0;

    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (Date.now() - startedAt > TIMEOUT_MS) {
        throw new Error(
          "Suivi de l'import abandonné après 1h d'attente — le traitement continue probablement " +
            "côté serveur : vérifiez /history dans quelques minutes avant de relancer l'import.",
        );
      }

      let job: {
        status: string;
        phase: string | null;
        progress: number;
        totalBuilt: number;
        analysisId: number | null;
        report?: {
          warnings?: string[];
          errorCount?: number;
          conformityScore?: number;
          totalFeatures?: number;
        } | null;
        error?: string | null;
      };
      try {
        const jr = await fetch(`/api/import-jobs/${jobId}`, {
          cache: "no-store",
        });
        if (!jr.ok) throw new Error(String(jr.status));
        job = await jr.json();
        netErrors = 0;
      } catch {
        if (++netErrors > 5)
          throw new Error("Suivi de l'import interrompu (réseau).");
        continue;
      }

      setJobPhase(job.phase ?? null);
      setJobProgress(job.progress ?? 0);

      if (job.status === "completed") {
        const warnings = job.report?.warnings ?? [];
        const errorCount = job.report?.errorCount ?? 0;
        setUploadStep("done");
        setAnalysisResult({
          id: job.analysisId ?? 0,
          totalFeatures: job.report?.totalFeatures ?? job.totalBuilt ?? 0,
          errorCount,
          conformityScore: job.report?.conformityScore ?? 0,
        });
        if (warnings.length) {
          // Console EN PLUS du toast (persiste dans les DevTools, contrairement
          // au toast qui disparaît) — pratique pour copier le rapport complet.
          console.log(`[import job ${jobId}] avertissements :`, warnings);
          // Tous les avertissements (pas seulement les 3 premiers) — même
          // correctif que le chemin synchrone `upload-geo`, cf. plus haut.
          toast.warning("Vérifications", {
            description: warnings.join(" · "),
            duration: 20000,
          });
        }
        toast.success("Traitement terminé", {
          description: `${job.totalBuilt} parcelles · ${errorCount} erreur(s)`,
        });
        return;
      }
      if (job.status === "failed") {
        throw new Error(job.error || "Import échoué.");
      }
      if (job.status === "cancelled") {
        toast.info("Import annulé.");
        return;
      }
      setUploadStep("analyzing"); // conserve le spinner pendant le traitement
    }
  }, []);

  const handleCancelImport = useCallback(async () => {
    if (!currentJobId) return;
    await fetch(`/api/import-jobs/${currentJobId}/cancel`, { method: "POST" });
  }, [currentJobId]);

  /** Démarre un job depuis un fichier déjà téléversé (inventaire) + mappage validé. */
  const startMappedImport = useCallback(
    async (
      inv: LayerInventory,
      layerMapping: Record<string, string> | undefined,
    ) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(inv.fileName);
      setUploadStep("reading");
      setJobPhase("read");
      setJobProgress(0);
      setJobSteps(DXF_PIPELINE_STEPS);
      setAnalysisResult(null);

      try {
        const res = await fetch("/api/import-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey: inv.fileKey,
            fileName: inv.fileName,
            sourceType: inv.sourceType,
            layerMapping,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(e.error || `Erreur serveur: ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: number };
        await pollImportJob(jobId);
      } catch (err) {
        toast.error("Erreur d'import", { description: String(err) });
        resetUpload();
      }
    },
    [pollImportJob, resetUpload],
  );

  /**
   * Démarre le job `parcelles` (page d'accueil) depuis un fichier déjà
   * téléversé (inventaire de champs) + mappage nicad/numParcelle validé.
   * Symétrique de `startMappedImport` (DXF/DGN, mappage de calques) pour le
   * mappage d'attributs shapefile.
   */
  const startFieldMappedShapefileImport = useCallback(
    async (
      fileKey: string,
      fileName: string,
      layerMapping: Record<string, string> | undefined,
    ) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(fileName);
      setUploadStep("reading");
      setJobPhase("read");
      setJobProgress(0);
      setJobSteps(SHP_PARCELLES_STEPS);
      setAnalysisResult(null);

      try {
        const res = await fetch("/api/import-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey,
            fileName,
            sourceType: "SHP",
            kind: "parcelles",
            layerMapping,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(e.error || `Erreur serveur: ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: number };
        await pollImportJob(jobId);
      } catch (err) {
        toast.error("Erreur d'import", { description: String(err) });
        resetUpload();
      }
    },
    [pollImportJob, resetUpload],
  );

  /**
   * Import direct (voie historique multipart, sans mappage) — repli si
   * l'inventaire des calques échoue.
   */
  const runCaoImport = useCallback(
    async (
      fileList: File[],
      mainFile: File,
      steps: JobProgressStep[] = DXF_PIPELINE_STEPS,
    ) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(mainFile.name);
      setUploadStep("reading");
      setJobPhase("read");
      setJobProgress(0);
      setJobSteps(steps);
      setAnalysisResult(null);

      try {
        const formData = new FormData();
        fileList.forEach((f) => formData.append("files", f));

        const res = await fetch("/api/import-jobs", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(e.error || `Erreur serveur: ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: number };
        await pollImportJob(jobId);
      } catch (err) {
        toast.error("Erreur d'import", { description: String(err) });
        resetUpload();
      }
    },
    [pollImportJob, resetUpload],
  );

  /**
   * Étape « mappage » pour un shapefile page d'accueil : inventorie les
   * colonnes .dbf (target `parcelles-home` : nicad + numParcelle
   * uniquement) puis ouvre la modale de mappage. En cas d'échec (fichier
   * illisible, erreur réseau), repli sur l'import direct sans mappage —
   * même contrat que `requestLayerInventory` pour les DXF.
   */
  const requestShapefileFieldInventory = useCallback(
    async (fileList: File[], shpFile: File) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(shpFile.name);
      setUploadStep("reading");
      setAnalysisResult(null);

      try {
        const formData = new FormData();
        formData.append("target", "parcelles-home");
        fileList.forEach((f) => formData.append("files", f));

        const res = await fetch("/api/cadastre/import/inventory", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(String(res.status));
        const inv = (await res.json()) as ShapefileFieldInventory;

        // Suspend le spinner, la modale prend le relais jusqu'à validation.
        setIsUploading(false);
        setUploadStep(null);
        setPendingFieldInventory(inv);
      } catch {
        // Repli robuste : import direct via la voie multipart historique.
        await runCaoImport(fileList, shpFile, SHP_PARCELLES_STEPS);
      }
    },
    [runCaoImport],
  );

  /**
   * Étape « variante simple » : inventorie les calques du fichier CAO puis ouvre
   * la modale de mappage. En cas d'échec (calques illisibles, conversion DGN
   * indisponible…), repli sur l'import direct.
   */
  const requestLayerInventory = useCallback(
    async (fileList: File[], mainFile: File) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(mainFile.name);
      setUploadStep("reading");
      setAnalysisResult(null);

      try {
        const formData = new FormData();
        fileList.forEach((f) => formData.append("files", f));

        const res = await fetch("/api/import-jobs/inventory", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(String(res.status));
        const inv = (await res.json()) as LayerInventory;

        if (!inv.layers?.length) {
          // Aucun calque lisible : lancer directement le traitement (sans mappage).
          await startMappedImport(inv, undefined);
          return;
        }

        // Suspend le spinner, la modale prend le relais jusqu'à validation.
        setIsUploading(false);
        setUploadStep(null);
        setPendingInventory(inv);
      } catch {
        // Repli robuste : import direct via la voie multipart historique.
        await runCaoImport(fileList, mainFile);
      }
    },
    [runCaoImport, startMappedImport],
  );

  const handleFiles = useCallback(
    async (fileList: File[]) => {
      if (
        !fileList.length ||
        isUploading ||
        pendingInventory ||
        pendingFieldInventory
      )
        return;

      const mainFile =
        fileList.find(
          (f) =>
            !f.name.toLowerCase().endsWith(".dbf") &&
            !f.name.toLowerCase().endsWith(".prj"),
        ) || fileList[0];

      // Fichiers CAO volumineux (DXF/DGN) → inventaire des calques + mappage, puis
      // import asynchrone vers cad_parcelles (cf. Phase 1). Cherché dans TOUTE la
      // sélection (pas seulement `mainFile`) : l'ordre des fichiers rendu par le
      // navigateur est alphabétique, pas garanti mettre le fichier pertinent en
      // premier (ex. un export QGIS inclut souvent un .cpg qui trie avant .shp).
      const dxfDgnFile = fileList.find((f) => /\.(dxf|dgn)$/i.test(f.name));
      if (dxfDgnFile) {
        void requestLayerInventory(fileList, dxfDgnFile);
        return;
      }

      const shpFile = fileList.find((f) =>
        f.name.toLowerCase().endsWith(".shp"),
      );
      if (shpFile) {
        void requestShapefileFieldInventory(fileList, shpFile);
        return;
      }

      setIsUploading(true);
      setUploadFileName(mainFile.name);
      setUploadStep("reading");

      try {
        const formData = new FormData();
        fileList.forEach((f) => formData.append("files", f));

        const uploadRes = await fetch("/api/upload-geo", {
          method: "POST",
          body: formData,
        });
        if (!uploadRes.ok) {
          const err = await uploadRes
            .json()
            .catch(() => ({ error: uploadRes.statusText }));
          throw new Error(err.error || `Erreur serveur: ${uploadRes.status}`);
        }

        const parsed = (await uploadRes.json()) as {
          geoJson: string;
          featureCount: number;
          format: string;
          crs: string;
          microstationReport?: {
            warnings: string[];
            nbParcelles: number;
            nbSansNumero: number;
          };
        };

        if (parsed.microstationReport?.warnings?.length) {
          // Console EN PLUS du toast (persiste dans les DevTools, contrairement
          // au toast qui disparaît) — pratique pour copier le rapport complet.
          console.log(
            "[upload-geo] avertissements :",
            parsed.microstationReport.warnings,
          );
          // Tous les avertissements (pas seulement les 3 premiers, séparateur
          // " · " — sonner ne préserve pas les retours à la ligne bruts sans
          // config CSS dédiée) : un rapport DXF en porte facilement 10+, et le
          // diagnostic pertinent (ex. section/NICAD non résolu) était souvent
          // hors des 3 premiers, donc invisible. Durée allongée pour tout lire.
          toast.warning("Vérifications Microstation", {
            description: parsed.microstationReport.warnings.join(" · "),
            duration: 20000,
          });
        }

        setUploadStep("analyzing");
        await new Promise((r) => setTimeout(r, 300));
        setUploadStep("ai");

        const analysisRes = await fetch("/api/analyses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: mainFile.name,
            fileFormat: parsed.format,
            fileSize: mainFile.size,
            geoJsonData: parsed.geoJson,
            microstationReport: parsed.microstationReport,
          }),
        });

        if (!analysisRes.ok) {
          const err = await analysisRes
            .json()
            .catch(() => ({ error: analysisRes.statusText }));
          throw new Error(err.error || "Erreur analyse");
        }

        const data = await analysisRes.json();
        setUploadStep("done");
        setAnalysisResult({
          id: data.id,
          totalFeatures: data.totalFeatures,
          errorCount: data.errorCount,
          conformityScore: data.conformityScore,
        });

        toast.success("Analyse terminée", {
          description: `${data.totalFeatures} entités · ${data.errorCount} erreurs · Score: ${data.conformityScore}%`,
        });
      } catch (err) {
        toast.error("Erreur de chargement", { description: String(err) });
        setIsUploading(false);
        setUploadStep(null);
        setUploadFileName(null);
      }
    },
    [
      isUploading,
      pendingInventory,
      pendingFieldInventory,
      requestLayerInventory,
      requestShapefileFieldInventory,
    ],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) handleFiles(files);
    },
    [handleFiles],
  );

  return (
    <div className="min-h-screen bg-background text-foreground overflow-auto">
      <NavBar user={user} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage:
              "linear-gradient(oklch(0.65 0.18 220) 1px, transparent 1px), linear-gradient(90deg, oklch(0.65 0.18 220) 1px, transparent 1px)",
            backgroundSize: "50px 50px",
          }}
        />
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-425 h-100 rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse, oklch(0.65 0.18 220 / 0.15), transparent 70%)",
          }}
        />

        <div className="relative mx-auto px-6 pt-8 pb-6">
          <div className="text-center max-w-5xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/5 text-primary text-xs font-medium mb-4">
              <Activity className="w-3.5 h-3.5" />
              Fiabilisation des données cadastrales — Sénégal
            </div>

            <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-tight">
              Fiabiliser les données cadastrales
              <br />
              <span className="text-primary">
                détection, correction et traçabilité
              </span>
            </h1>

            <p className="text-lg text-muted-foreground mb-10 max-w-3xl mx-auto leading-relaxed">
              Détection des erreurs topologiques, corrections proposées et
              rapports d&apos;analyse sur vos fichiers SHP, GeoJSON, DGN et DXF.
            </p>

            {/* Workflow — pipeline DXF réel (lecture → mappage → polygonisation → jointure) */}
            <DxfPipelineSection />

            <h3 className="text-primary text-4xl font-bold tracking-tight my-6 leading-tight">
              Statistiques
            </h3>

            {stats.totalAnalyses > 0 && (
              <div className="flex items-center justify-center gap-6 mt-4 mb-10 text-lg">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Database className="w-4 h-4 text-primary" />
                  <span>
                    <strong className="font-serif text-foreground">
                      {stats.totalAnalyses}
                    </strong>{" "}
                    analyses
                  </span>
                </div>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="w-4 h-4 text-blue-400" />
                  <span>
                    <strong className="font-serif text-foreground">
                      {(stats.totalParcelles ?? 0).toLocaleString()}
                    </strong>{" "}
                    parcelles traitées
                  </span>
                </div>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span>
                    Conformité moy.{" "}
                    <strong className="font-serif text-green-400">
                      {toNum(stats.avgConformity).toFixed(1)}%
                    </strong>
                  </span>
                </div>
              </div>
            )}

            {/* Format chips */}
            <div className="flex flex-wrap justify-center gap-2 mb-10">
              {FORMATS.map((f) => (
                <span
                  key={f}
                  className="px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground text-xs font-mono border border-border"
                >
                  {f}
                </span>
              ))}
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed rounded-2xl p-14 transition-all cursor-pointer group max-w-2xl mx-auto ${
                isDragging
                  ? "border-primary bg-primary/5 scale-[1.01]"
                  : "border-border hover:border-primary/50 hover:bg-secondary/20"
              }`}
              onClick={() => {
                if (!isUploading)
                  document.getElementById("file-input")?.click();
              }}
            >
              <input
                id="file-input"
                type="file"
                accept=".geojson,.json,.shp,.dbf,.prj,.zip,.kml,.csv,.dgn,.dxf"
                className="hidden"
                multiple
                disabled={isUploading}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) handleFiles(files);
                  e.target.value = "";
                }}
              />

              {isUploading ? (
                <div className="flex flex-col items-center gap-6">
                  {uploadStep === "done" && analysisResult ? (
                    /* ── Résultat + boutons d'action ── */
                    <div className="flex flex-col items-center gap-5 w-full">
                      <div className="flex items-center gap-3">
                        <CheckCircle className="w-8 h-8 text-green-400" />
                        <div className="text-left">
                          <p className="text-sm font-semibold text-green-400">
                            Analyse terminée
                          </p>
                          <p className="text-xs text-muted-foreground font-mono truncate max-w-52">
                            {uploadFileName}
                          </p>
                        </div>
                      </div>

                      {/* KPIs rapides */}
                      <div className="flex gap-4 text-center">
                        <div>
                          <p className="text-2xl font-bold text-primary">
                            {analysisResult.totalFeatures.toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Parcelles
                          </p>
                        </div>
                        <div className="w-px bg-border" />
                        <div>
                          <p className="text-2xl font-bold text-red-400">
                            {analysisResult.errorCount}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Erreurs
                          </p>
                        </div>
                        <div className="w-px bg-border" />
                        <div>
                          <p
                            className={`text-2xl font-bold ${analysisResult.conformityScore >= 70 ? "text-green-400" : "text-orange-400"}`}
                          >
                            {analysisResult.conformityScore.toFixed(0)}%
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Conformité
                          </p>
                        </div>
                      </div>

                      {/* Boutons d'action */}
                      <div className="flex gap-3 flex-wrap justify-center w-full">
                        <Button
                          size="lg"
                          className="gap-2 flex-1 min-w-40 shadow-lg shadow-primary/20"
                          onClick={() =>
                            router.push(`/map/${analysisResult.id}`)
                          }
                        >
                          <MapPin className="w-4 h-4" /> Voir sur la carte
                        </Button>
                        <Button
                          size="lg"
                          variant="outline"
                          className="gap-2 flex-1 min-w-40"
                          onClick={() =>
                            router.push(`/map/${analysisResult.id}?tab=table`)
                          }
                        >
                          <Database className="w-4 h-4" /> Voir les données
                        </Button>
                      </div>

                      <button
                        onClick={resetUpload}
                        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Charger un autre fichier
                      </button>
                    </div>
                  ) : (
                    /* ── Progression ── */
                    <>
                      <div className="relative w-20 h-20">
                        {/* Anneau de chargement */}
                        <div className="absolute inset-0 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                        {/* Halo pulsant dans le cercle (signal « traitement en cours ») */}
                        <div className="absolute inset-2 rounded-full bg-primary/10 animate-pulse" />
                        {/* Cerveau au centre, pulsant */}
                        <Brain className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
                      </div>
                      {uploadFileName && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary border text-xs">
                          <FileText className="w-3.5 h-3.5 text-primary" />
                          <span className="font-mono truncate max-w-48">
                            {uploadFileName}
                          </span>
                        </div>
                      )}
                      {mode === "import" ? (
                        <div className="w-full max-w-sm space-y-3">
                          <JobProgressSteps
                            steps={jobSteps}
                            phase={jobPhase}
                            status="running"
                            progress={jobProgress}
                          />
                          <div className="text-center">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={handleCancelImport}
                            >
                              Annuler
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-primary font-medium">
                          {uploadStep === "reading" && "Lecture du fichier..."}
                          {uploadStep === "analyzing" &&
                            "Analyse topologique en cours..."}
                          {uploadStep === "ai" &&
                            "Génération du rapport d'analyse..."}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-5">
                  <div
                    className={`w-20 h-20 rounded-2xl border-2 flex items-center justify-center transition-all ${isDragging ? "border-primary bg-primary/10 scale-110" : "border-border group-hover:border-primary/50"}`}
                  >
                    <Upload
                      className={`w-9 h-9 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`}
                    />
                  </div>
                  <div className="text-center">
                    <p className="text-xl font-semibold mb-2">
                      {isDragging
                        ? "Déposez vos fichiers ici"
                        : "Glissez-déposez vos fichiers cadastraux"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      ou{" "}
                      <span className="text-primary underline">
                        parcourez vos fichiers
                      </span>{" "}
                      — SHP, GeoJSON, DGN, DXF, KML, CSV
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Pour les Shapefiles : sélectionnez{" "}
                      <strong>.shp + .dbf + .prj</strong> ensemble
                    </p>
                  </div>
                  <div className="flex items-center gap-6 text-xs text-muted-foreground border-t border-border pt-4 w-full justify-center">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />{" "}
                      Analyse automatique
                    </span>
                    <span className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />{" "}
                      Rapport IA instantané
                    </span>
                    <span className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />{" "}
                      Carte interactive
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/map")}
                className="gap-2 text-muted-foreground"
              >
                <MapPin className="w-4 h-4" /> Ouvrir la carte{" "}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
              <span className="text-border">|</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/history")}
                className="gap-2 text-muted-foreground"
              >
                <History className="w-4 h-4" /> Historique{" "}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Error types */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold mb-3">
            6 Types d&apos;Anomalies Détectées
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Chaque type d&apos;erreur est identifié, localisé et expliqué par
            l&apos;agent IA
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {ERROR_TYPES.map((err) => (
            <div
              key={err.label}
              className="rounded-xl border border-border bg-card p-5 text-center hover:border-primary/30 transition-all group"
            >
              <div
                className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center group-hover:scale-110 transition-transform"
                style={{
                  background: `${err.color}20`,
                  border: `1px solid ${err.color}40`,
                }}
              >
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: err.color }}
                />
              </div>
              <p className="text-xs font-semibold mb-1">{err.label}</p>
              <p className="text-[10px] text-muted-foreground font-mono">
                {err.sublabel}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-3">Fonctionnalités</h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Contrôles topologiques, cartographie et rapports pour les données
            cadastrales du Sénégal
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feat) => (
            <div
              key={feat.title}
              className="rounded-xl border border-border bg-card p-6 hover:border-primary/30 transition-all hover:shadow-xl group"
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"
                style={{
                  background: `${feat.color}15`,
                  border: `1px solid ${feat.color}30`,
                }}
              >
                <feat.icon className="w-6 h-6" style={{ color: feat.color }} />
              </div>
              <h3 className="font-semibold mb-2">{feat.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {feat.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-12 text-center relative overflow-hidden">
          <TrendingUp className="w-12 h-12 text-primary mx-auto mb-4" />
          <h2 className="text-3xl font-bold mb-3">
            Prêt à fiabiliser vos données cadastrales ?
          </h2>
          <p className="text-muted-foreground mb-8 max-w-lg mx-auto">
            Chargez votre fichier SHP, GeoJSON ou DGN et obtenez un rapport
            d&apos;expert en quelques minutes
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Button
              size="lg"
              onClick={() => document.getElementById("file-input")?.click()}
              className="gap-2 shadow-xl shadow-primary/20 px-8"
            >
              <Upload className="w-5 h-5" /> Charger un fichier
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => router.push("/map")}
              className="gap-2 px-8"
            >
              <MapPin className="w-5 h-5" /> Explorer la carte{" "}
              <ArrowRight className="w-4 h-4" />
            </Button>
            <Button
              size="lg"
              variant="ghost"
              onClick={() => router.push("/dashboard")}
              className="gap-2 px-8 text-muted-foreground"
            >
              <BarChart2 className="w-5 h-5" /> Tableau de bord
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <span className="font-semibold text-foreground">GéoAino</span>
            <span>Fiabilisation des données cadastrales</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="/dashboard"
              className="hover:text-foreground transition-colors"
            >
              Tableau de bord
            </a>
            <a
              href="/history"
              className="hover:text-foreground transition-colors"
            >
              Historique
            </a>
            <a
              href="/reports"
              className="hover:text-foreground transition-colors"
            >
              Rapports
            </a>
          </div>
        </div>
      </footer>

      {pendingInventory && (
        <LayerMappingModal
          fileName={pendingInventory.fileName}
          layers={pendingInventory.layers}
          onCancel={resetUpload}
          onConfirm={(mapping) => {
            const inv = pendingInventory;
            setPendingInventory(null);
            void startMappedImport(inv, mapping);
          }}
        />
      )}

      {pendingFieldInventory && (
        <FieldMappingModal
          fileName={pendingFieldInventory.fileName}
          targetFields={pendingFieldInventory.targetFields}
          availableFields={pendingFieldInventory.fields}
          proposedMapping={pendingFieldInventory.proposedMapping}
          onCancel={resetUpload}
          onConfirm={(mapping) => {
            const inv = pendingFieldInventory;
            setPendingFieldInventory(null);
            void startFieldMappedShapefileImport(
              inv.fileKey,
              inv.fileName,
              mapping,
            );
          }}
        />
      )}
    </div>
  );
}
