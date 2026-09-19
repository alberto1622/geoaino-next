"use client";
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Brain, FileText, CheckCircle, Database, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import LayerMappingModal, {
  type LayerInventoryEntry,
} from "@/components/LayerMappingModal";
import FieldMappingModal from "@/components/FieldMappingModal";
import {
  JobProgressSteps,
  type JobProgressStep,
} from "@/components/import/JobProgressSteps";
import type { TargetFieldDef } from "@/lib/import/field-mapping";

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

/** Pipeline job kind "parcelles" shapefile (`run-shapefile-job.ts`) : pas d'étape "build" distincte (déjà des polygones). */
const SHP_PARCELLES_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "nicad", label: "Résolution des NICAD" },
  { key: "analyze", label: "Analyse topologique" },
];

interface NewAnalysisPanelProps {
  /**
   * Rendu à l'intérieur d'une fenêtre modale (pages historique/carte) :
   *  - dès que l'analyse est prête (id réel), navigue vers `/map/[id]` au lieu
   *    d'afficher la carte résultat + boutons ;
   *  - les sous-modales de mappage passent au-dessus des panneaux flottants de
   *    la carte (`z-[1000]`, cf. § 34 bis) et de l'overlay de la modale hôte.
   */
  inModal?: boolean;
  /** Notifié avec l'id de l'analyse produite dès qu'elle est prête. */
  onSuccess?: (analysisId: number) => void;
  className?: string;
}

/** Poignée impérative : ouvrir le sélecteur de fichier depuis l'extérieur
 *  (ex. bouton « Charger un fichier » de la section CTA de `HomeClient`). */
export interface NewAnalysisPanelHandle {
  openFilePicker: () => void;
}

/**
 * Flux « nouvelle analyse » complet (glisser-déposer + détection de format +
 * mappage des calques DXF / des champs shapefile + progression du job + carte
 * résultat), extrait de `HomeClient` pour être réutilisé tel quel dans une
 * fenêtre modale (`NewAnalysisModal`) depuis les pages historique et carte.
 * La page d'accueil le rend sans `inModal` : comportement d'origine inchangé.
 */
const NewAnalysisPanel = forwardRef<
  NewAnalysisPanelHandle,
  NewAnalysisPanelProps
>(function NewAnalysisPanel({ inModal = false, onSuccess, className }, ref) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
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
          // Console pour le debug — les warnings techniques restent accessibles
          // dans le rapport d'analyse détaillé (onglet erreurs/rapport).
          console.log(`[import job ${jobId}] avertissements :`, warnings);
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

  useImperativeHandle(
    ref,
    () => ({ openFilePicker: () => fileInputRef.current?.click() }),
    [],
  );

  // Mode modale : dès que l'analyse est prête avec un id réel, on ouvre la
  // carte plutôt que d'afficher la carte résultat dans la fenêtre modale.
  useEffect(() => {
    if (uploadStep !== "done" || !analysisResult?.id) return;
    onSuccess?.(analysisResult.id);
    if (inModal) router.push(`/map/${analysisResult.id}`);
  }, [uploadStep, analysisResult, inModal, onSuccess, router]);

  const subModalOverlayClassName = inModal ? "z-[1200]" : undefined;
  const navigatingToMap =
    inModal && uploadStep === "done" && !!analysisResult && analysisResult.id > 0;

  return (
    <div className={className}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-lg p-14 transition-all cursor-pointer group max-w-2xl mx-auto ${
          isDragging
            ? "border-primary bg-primary/5 scale-[1.01]"
            : "border-border hover:border-primary/50 hover:bg-secondary/20"
        }`}
        onClick={() => {
          if (!isUploading) fileInputRef.current?.click();
        }}
      >
        <input
          ref={fileInputRef}
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

        {navigatingToMap ? (
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
              <MapPin className="w-6 h-6 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            </div>
            <p className="text-sm text-primary font-medium">
              Analyse terminée — ouverture de la carte…
            </p>
          </div>
        ) : isUploading ? (
          <div className="flex flex-col items-center gap-6">
            {uploadStep === "done" && analysisResult ? (
              /* ── Résultat + boutons d'action ── */
              <div className="flex flex-col items-center gap-5 w-full">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-8 h-8 text-good" />
                  <div className="text-left">
                    <p className="text-sm font-semibold text-good">
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
                    <p className="text-2xl font-bold tabular-nums text-primary">
                      {analysisResult.totalFeatures.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">Parcelles</p>
                  </div>
                  <div className="w-px bg-border" />
                  <div>
                    <p className="text-2xl font-bold tabular-nums text-crit">
                      {analysisResult.errorCount}
                    </p>
                    <p className="text-xs text-muted-foreground">Erreurs</p>
                  </div>
                  <div className="w-px bg-border" />
                  <div>
                    <p
                      className={`text-2xl font-bold tabular-nums ${analysisResult.conformityScore >= 70 ? "text-good" : "text-warn"}`}
                    >
                      {analysisResult.conformityScore.toFixed(0)}%
                    </p>
                    <p className="text-xs text-muted-foreground">Conformité</p>
                  </div>
                </div>

                {/* Boutons d'action */}
                <div className="flex gap-3 flex-wrap justify-center w-full">
                  <Button
                    size="lg"
                    className="gap-2 flex-1 min-w-40 shadow-lg shadow-primary/20"
                    onClick={() => router.push(`/map/${analysisResult.id}`)}
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
              className={`w-20 h-20 rounded-lg border-2 flex items-center justify-center transition-all ${isDragging ? "border-primary bg-primary/10 scale-110" : "border-border group-hover:border-primary/50"}`}
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
                <CheckCircle className="w-3.5 h-3.5 text-good" /> Analyse
                automatique
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-good" /> Rapport IA
                instantané
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-good" /> Carte
                interactive
              </span>
            </div>
          </div>
        )}
      </div>

      {pendingInventory && (
        <LayerMappingModal
          fileName={pendingInventory.fileName}
          layers={pendingInventory.layers}
          overlayClassName={subModalOverlayClassName}
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
          overlayClassName={subModalOverlayClassName}
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
});

export default NewAnalysisPanel;
