"use client";
import { PageTitle } from "@/components/PageTitle";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
} from "react";
import { toast } from "sonner";
import { ArrowDown, Download, Eye, History, Layers, Loader2, Play, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import FieldMappingModal from "@/components/FieldMappingModal";
import {
  JobProgressSteps,
  type JobProgressStep,
} from "@/components/import/JobProgressSteps";
import {
  previewToutes,
  executerCommune,
  executerToutes,
  executerBasculementListe,
  historiqueMigrations,
  consulterMigrationJob,
  supprimerMigrationJob,
} from "../_actions/migration";
import type {
  BasculeNicadItem,
  BasculeNicadReport,
} from "@/lib/import/run-bascule-job";

type Preview = {
  syscol2013: string;
  syscol2026: string | null;
  nomCommune2013: string;
  nomCommune2026: string | null;
  nbParcelles: number;
  statut: string;
};

// Alias locaux — types réels définis (et exportés) dans run-bascule-job.ts,
// seule source de vérité pour la forme du rapport `job.report`. `import type`
// est entièrement effacé à la compilation : sûr à référencer depuis ce
// composant client bien que le module source soit server-only (finding 4
// revue finale — évite la redéclaration manuelle qui pouvait diverger).
type BasculeItem = BasculeNicadItem;
type BasculeReport = BasculeNicadReport;

// Résultat d'exécution par ligne, fusionné après `executerBasculementListe`
// (finding 3 revue finale) — permet d'afficher quelles lignes ont réellement
// basculé sans faire disparaître tout le rapport de prévisualisation.
type ResultatLigne = {
  success: boolean;
  nicadNouveau?: string;
  error?: string;
};

// Taille de lot pour l'exécution (finding 2 revue finale) : reste sous la
// limite serveur de `executerBasculementListe` (.max(1000)) avec marge, et
// les lots s'exécutent STRICTEMENT en séquence (jamais en parallèle) — le
// chemin complexe de `basculerNicadCore` fait un lire-puis-écrire de
// `getLastNumParcelleGlobal`/`insertParcelle` par élément qui doit rester
// ordonné pour éviter des doublons de numéro de parcelle.
const TAILLE_LOT_BASCULEMENT = 500;

const BASCULE_JOB_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "identify", label: "Identification des cibles 2026" },
];

// Filtre du tableau de prévisualisation. "invalides" bascule sur une source
// de données différente (`basculeReport.invalides`, pas `.items`) — ces
// lignes n'ont jamais été identifiées (NICAD absent/mal formé en amont),
// donc pas de cible/statut/réserves à afficher pour elles.
type FiltreStatut =
  | "toutes"
  | "clean"
  | "reserve"
  | "sansCorrespondance"
  | "dejaAJour"
  | "invalides";

const FILTRE_OPTIONS: { value: FiltreStatut; label: string }[] = [
  { value: "toutes", label: "Toutes les lignes" },
  { value: "clean", label: "Sans réserve" },
  { value: "reserve", label: "Avec réserve" },
  { value: "sansCorrespondance", label: "Sans correspondance 2026" },
  { value: "dejaAJour", label: "Déjà à jour" },
  { value: "invalides", label: "Invalides" },
];

// Catégories mutuellement exclusives, dérivées des mêmes champs que les
// stats déjà affichées (aucun changement de leur calcul) — "avec réserve"
// et "sans correspondance" étaient jusqu'ici fondues dans la même
// statistique `avecReserve` ; le filtre les distingue sans rien changer
// au comptage agrégé du bandeau au-dessus du tableau.
function itemMatchesFiltre(item: BasculeItem, filtre: FiltreStatut): boolean {
  switch (filtre) {
    case "toutes":
      return true;
    case "dejaAJour":
      return item.dejaAJour;
    case "clean":
      return item.clean;
    case "sansCorrespondance":
      return !item.dejaAJour && !item.proposition;
    case "reserve":
      return !item.dejaAJour && !item.clean && !!item.proposition;
    case "invalides":
      return false; // rendu séparément, cf. `basculeReport.invalides`
  }
}

export default function MigrationPage() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingInventory, setPendingInventory] = useState<{
    fileKey: string;
    fileName: string;
    targetFields: {
      key: string;
      label: string;
      aliases: string[];
      required?: boolean;
    }[];
    fields: { name: string; sampleValues: string[] }[];
    proposedMapping: Record<string, string>;
  } | null>(null);
  const [basculeJob, setBasculeJob] = useState<{
    id: number;
    status: string;
    phase: string | null;
    progress: number;
    error?: string | null;
  } | null>(null);
  const [basculeReport, setBasculeReport] = useState<BasculeReport | null>(
    null,
  );
  const [selectedForBascule, setSelectedForBascule] = useState<Set<string>>(
    new Set(),
  );
  const [executingBascule, setExecutingBascule] = useState(false);
  const [filtreStatut, setFiltreStatut] = useState<FiltreStatut>("toutes");
  const [chargementInventaire, setChargementInventaire] = useState(false);
  // Distinct de `pending` (partagé avec les actions de migration par commune,
  // qui rechargent aussi via `reload()`) : ne sert qu'à afficher un état de
  // chargement au tout premier rendu, avant que `previews` n'ait jamais été
  // rempli — sans lui, le tableau affichait à tort "Aucune commune éligible"
  // pendant l'appel initial à `previewToutes()`.
  const [chargementInitial, setChargementInitial] = useState(true);
  const [executionProgress, setExecutionProgress] = useState<{
    chunk: number;
    total: number;
  } | null>(null);
  const [resultatsExecution, setResultatsExecution] = useState<
    Map<string, ResultatLigne>
  >(new Map());
  const [historique, setHistorique] = useState<
    Awaited<ReturnType<typeof historiqueMigrations>>
  >([]);
  const [chargementHistorique, setChargementHistorique] = useState(true);
  const [exportEnCours, setExportEnCours] = useState(false);
  const [consultationEnCours, setConsultationEnCours] = useState<number | null>(null);
  const [jobASupprimer, setJobASupprimer] = useState<{ id: number; fileName: string } | null>(null);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);

  function reload() {
    startTransition(async () => {
      try {
        setPreviews((await previewToutes()) as Preview[]);
      } catch {
        toast.error("Action non autorisée ou erreur de prévisualisation.");
      } finally {
        setChargementInitial(false);
      }
    });
  }

  function chargerHistorique() {
    startTransition(async () => {
      try {
        setHistorique(await historiqueMigrations({ limit: 20 }));
      } catch {
        // Silencieux — l'historique est un complément d'information, jamais
        // bloquant pour le flux principal de migration.
      } finally {
        setChargementHistorique(false);
      }
    });
  }

  useEffect(reload, []);
  useEffect(chargerHistorique, []);

  // Recharge un lot passé dans le MÊME tableau de prévisualisation que pour
  // un job en cours (état déjà "completed" → l'effet de suivi ci-dessous ne
  // le repolle pas) — réutilise tel quel le tableau, les filtres et le
  // bouton d'export existants.
  async function consulterJob(jobId: number) {
    setConsultationEnCours(jobId);
    try {
      const job = await consulterMigrationJob({ jobId });
      setBasculeJob({
        id: job.id,
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        error: job.error,
      });
      setBasculeReport(job.report);
      setResultatsExecution(new Map());
      setSelectedForBascule(new Set());
      document
        .getElementById("previsualisation-migration")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setConsultationEnCours(null);
    }
  }

  async function confirmerSuppression() {
    if (!jobASupprimer) return;
    setSuppressionEnCours(true);
    try {
      await supprimerMigrationJob({ jobId: jobASupprimer.id });
      toast.success(`« ${jobASupprimer.fileName} » supprimé.`);
      if (basculeJob?.id === jobASupprimer.id) {
        setBasculeJob(null);
        setBasculeReport(null);
      }
      chargerHistorique();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSuppressionEnCours(false);
      setJobASupprimer(null);
    }
  }

  async function exporterShapefile() {
    if (!basculeJob) return;
    setExportEnCours(true);
    try {
      const res = await fetch("/api/cadastre/export/shapefile/migration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: basculeJob.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Échec de l'export.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "migration.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setExportEnCours(false);
    }
  }

  const totalParcelles = previews.reduce((s, p) => s + p.nbParcelles, 0);

  function migrerCommune(p: Preview) {
    if (!p.syscol2026) return;
    setBusy(p.syscol2013);
    startTransition(async () => {
      try {
        const res = await executerCommune({
          syscol2013: p.syscol2013,
          syscol2026: p.syscol2026!,
        });
        toast.success(
          `${p.nomCommune2013} : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`,
        );
        reload();
      } catch {
        toast.error("Échec de la migration.");
      } finally {
        setBusy(null);
      }
    });
  }

  function migrerToutes() {
    setBusy("ALL");
    startTransition(async () => {
      try {
        const res = await executerToutes();
        toast.success(
          `Migration globale : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`,
        );
        reload();
      } catch {
        toast.error("Échec de la migration globale.");
      } finally {
        setBusy(null);
      }
    });
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const shpFile = Array.from(files).find((f) =>
      f.name.toLowerCase().endsWith(".shp"),
    );
    const dbfFile = Array.from(files).find((f) =>
      f.name.toLowerCase().endsWith(".dbf"),
    );
    if (!shpFile || !dbfFile) {
      toast.error("Sélectionnez le .shp ET son .dbf ensemble.");
      e.target.value = "";
      return;
    }
    setBasculeReport(null);
    setBasculeJob(null);
    setResultatsExecution(new Map());
    setSelectedForBascule(new Set());
    const fd = new FormData();
    fd.append("target", "bascule-nicad");
    for (const f of Array.from(files)) fd.append("files", f);
    setChargementInventaire(true);
    try {
      const res = await fetch("/api/cadastre/import/inventory", {
        method: "POST",
        body: fd,
      });
      const inv = await res.json();
      if (!res.ok) throw new Error(inv.error || "Inventaire échoué");
      setPendingInventory(inv);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setChargementInventaire(false);
      e.target.value = "";
    }
  }

  async function startBasculeJob(mapping: Record<string, string>) {
    if (!pendingInventory) return;
    const inv = pendingInventory;
    setPendingInventory(null);
    try {
      const res = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: inv.fileKey,
          fileName: inv.fileName,
          sourceType: "SHP",
          kind: "bascule-nicad",
          layerMapping: mapping,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import échoué");
      setBasculeJob({
        id: data.jobId,
        status: data.status,
        phase: "read",
        progress: 0,
      });
    } catch (err) {
      toast.error(String(err));
    }
  }

  useEffect(() => {
    if (
      !basculeJob ||
      (basculeJob.status !== "pending" && basculeJob.status !== "running")
    )
      return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${basculeJob.id}`);
        const j = await res.json();
        setBasculeJob({
          id: j.id,
          status: j.status,
          phase: j.phase,
          progress: j.progress,
          error: j.error,
        });
        if (j.status === "completed") {
          setBasculeReport(j.report as BasculeReport);
          setResultatsExecution(new Map());
        } else if (j.status === "failed") {
          toast.error(j.error || "Échec de l'identification.");
        }
      } catch {
        // Prochain tick réessaiera — pas d'action sur une erreur réseau isolée.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [basculeJob]);

  // Finding 1 revue finale : une ligne n'est sélectionnable que si son
  // basculement peut être garanti sûr. `basculerNicadCore` ne vérifie
  // l'existence de la section cible QUE dans son branchement "complexe"
  // (quand `sectionNouvelle` est fourni) — le branchement "simple" ne
  // vérifie rien. Une ligne non "clean", sans `sectionNouvelle` proposée
  // (donc destinée au branchement simple) ET dont `sectionExisteEn2026`
  // n'est pas confirmé `true` ne doit donc JAMAIS être sélectionnable :
  // c'est exactement le cas "Aucune section 2026 ne recouvre significativement
  // la section 2013 … — nouvelle section à choisir (cas complexe)" où
  // `identifierBasculementNicad` laisse `proposition.sectionNouvelle`
  // volontairement `undefined` faute de pouvoir la déterminer.
  function peutSelectionnerLigne(item: BasculeItem): boolean {
    if (item.dejaAJour || !item.proposition) return false;
    if (
      !item.clean &&
      !item.proposition.sectionNouvelle &&
      item.sectionExisteEn2026 !== true
    )
      return false;
    return true;
  }

  function toggleSelected(nicad: string) {
    setSelectedForBascule((prev) => {
      const next = new Set(prev);
      if (next.has(nicad)) next.delete(nicad);
      else next.add(nicad);
      return next;
    });
  }

  function selectAllClean() {
    if (!basculeReport) return;
    setSelectedForBascule(
      new Set(
        basculeReport.items.filter((i) => i.clean).map((i) => i.nicadAncien),
      ),
    );
  }

  function selectAll() {
    if (!basculeReport) return;
    setSelectedForBascule(
      new Set(
        basculeReport.items
          .filter(peutSelectionnerLigne)
          .map((i) => i.nicadAncien),
      ),
    );
  }

  function executerSelection() {
    if (!basculeReport || selectedForBascule.size === 0) return;
    const items = basculeReport.items
      .filter((i) => selectedForBascule.has(i.nicadAncien) && i.proposition)
      .map((i) => ({
        nicadAncien: i.nicadAncien,
        syscolNouveau: i.proposition!.syscolNouveau,
        sectionNouvelle: i.proposition!.sectionNouvelle,
      }));

    // Découpage en lots ≤ TAILLE_LOT_BASCULEMENT, exécutés STRICTEMENT en
    // séquence (jamais Promise.all) — cf. commentaire sur la constante :
    // l'ordre inter-lots doit rester le même que l'ordre intra-lot pour la
    // numérotation séquentielle des parcelles côté cas complexe.
    const chunks: (typeof items)[] = [];
    for (let i = 0; i < items.length; i += TAILLE_LOT_BASCULEMENT) {
      chunks.push(items.slice(i, i + TAILLE_LOT_BASCULEMENT));
    }

    setExecutingBascule(true);
    setExecutionProgress(
      chunks.length > 1 ? { chunk: 0, total: chunks.length } : null,
    );
    startTransition(async () => {
      let nbMigres = 0;
      let nbEchecs = 0;
      const resultatsParNicad = new Map<string, ResultatLigne>();
      try {
        for (let c = 0; c < chunks.length; c++) {
          setExecutionProgress(
            chunks.length > 1 ? { chunk: c + 1, total: chunks.length } : null,
          );
          const res = await executerBasculementListe({ items: chunks[c] });
          nbMigres += res.nbMigres;
          nbEchecs += res.nbEchecs;
          for (const r of res.resultats) {
            resultatsParNicad.set(r.nicadAncien, {
              success: r.success,
              nicadNouveau: r.nicadNouveau,
              error: r.error,
            });
          }
        }
        toast.success(`${nbMigres} basculé(s), ${nbEchecs} échec(s).`);
        setResultatsExecution(resultatsParNicad);
        setSelectedForBascule(new Set());
        chargerHistorique();
      } catch (err) {
        // Un lot a levé avant de renvoyer sa réponse (ex. erreur réseau/
        // serveur) — on garde quand même les résultats des lots précédents
        // déjà agrégés, pour ne pas perdre la visibilité sur ce qui a
        // effectivement basculé avant l'échec.
        setResultatsExecution(resultatsParNicad);
        toast.error(String(err));
      } finally {
        setExecutingBascule(false);
        setExecutionProgress(null);
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Migration en masse" />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Migration en masse
            </h1>
            <p className="text-sm text-muted-foreground">
              Basculement des NICAD Syscol 2013 → 2026 par commune ou en global.
            </p>
          </div>
        </div>
        {/* <Button onClick={migrerToutes} disabled={pending || previews.length === 0} className="gap-2">
          <Play className="h-4 w-4" /> Tout migrer
        </Button> */}
      </div>

      {/* <div className="grid grid-cols-1 gap-4 sm:grid-cols-3"> */}
      {/* <Card>
          <CardContent className="p-5">
            <p className="text-2xl font-bold">{previews.length}</p>
            <p className="text-xs text-muted-foreground">Communes éligibles</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-2xl font-bold">{totalParcelles.toLocaleString("fr-FR")}</p>
            <p className="text-xs text-muted-foreground">Parcelles à migrer</p>
          </CardContent>
        </Card>
      </div> */}

      {/* <Card>
        <CardHeader>
          <CardTitle className="text-base">Prévisualisation</CardTitle>
        </CardHeader>
        <CardContent>
          {chargementInitial ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement des communes éligibles…
            </p>
          ) : previews.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucune commune éligible. Confirmez des correspondances 2013→2026 au préalable.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr className="border-b border-border/50">
                    <th className="py-2 pr-3">Commune 2013</th>
                    <th className="py-2 pr-3">→ Syscol 2026</th>
                    <th className="py-2 pr-3 text-right">Parcelles</th>
                    <th className="py-2 pr-3">Statut</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {previews.map((p) => (
                    <tr key={p.syscol2013} className="border-b border-border/30">
                      <td className="py-2 pr-3">{p.nomCommune2013}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{p.syscol2026 ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.nbParcelles.toLocaleString("fr-FR")}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{p.statut}</td>
                      <td className="py-2 pr-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => migrerCommune(p)}
                          disabled={pending || busy === p.syscol2013}
                        >
                          {busy === p.syscol2013 ? "…" : "Migrer"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card> */}

      <Card id="previsualisation-migration">
        <CardHeader>
          <CardTitle className="text-base">
            Importer un shapefile (NICAD)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sélectionnez un shapefile (.shp + .dbf) portant une colonne NICAD
            2013 — la cible 2026 de chaque NICAD (commune, section, cas simple
            ou complexe) sera identifiée automatiquement avant tout basculement.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".shp,.dbf,.prj"
            onChange={handleFileSelected}
            className="hidden"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={
              chargementInventaire ||
              (!!basculeJob &&
                basculeJob.status !== "completed" &&
                basculeJob.status !== "failed")
            }
            className="gap-2"
          >
            {chargementInventaire ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {chargementInventaire
              ? "Lecture du fichier…"
              : "Choisir un shapefile"}
          </Button>

          {basculeJob &&
            (basculeJob.status === "pending" ||
              basculeJob.status === "running") && (
              <JobProgressSteps
                steps={BASCULE_JOB_STEPS}
                phase={basculeJob.phase}
                status={basculeJob.status as "pending" | "running"}
                progress={basculeJob.progress}
              />
            )}

          {basculeReport && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{basculeReport.stats.total} ligne(s) lue(s)</span>
                <span>·</span>
                <span>{basculeReport.stats.clean} sans réserve</span>
                <span>·</span>
                <span>{basculeReport.stats.avecReserve} avec réserve</span>
                <span>·</span>
                <span>{basculeReport.stats.dejaAJour} déjà à jour</span>
                <span>·</span>
                <span>{basculeReport.stats.invalides} invalide(s)</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAllClean}>
                  Sélectionner les lignes sans réserve
                </Button>
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Tout sélectionner
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exporterShapefile}
                  disabled={!basculeJob || exportEnCours}
                  className="gap-2"
                >
                  {exportEnCours ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Exporter en shapefile
                </Button>
                <Button
                  size="sm"
                  onClick={executerSelection}
                  disabled={selectedForBascule.size === 0 || executingBascule}
                  className="gap-2"
                >
                  <Play className="h-4 w-4" />
                  {executingBascule
                    ? executionProgress
                      ? `Basculement… (lot ${executionProgress.chunk}/${executionProgress.total})`
                      : "Basculement…"
                    : `Basculer la sélection (${selectedForBascule.size})`}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                  onClick={() =>
                    document
                      .getElementById("historique-migrations")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  <ArrowDown className="h-4 w-4" />
                  Retour à l&apos;historique
                </Button>
                <select
                  className="ml-auto h-8 rounded-lg border border-border bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={filtreStatut}
                  onChange={(e) =>
                    setFiltreStatut(e.target.value as FiltreStatut)
                  }
                >
                  {FILTRE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {filtreStatut === "invalides" ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border/50">
                        <th className="py-2 pr-3">Valeur brute</th>
                        <th className="py-2 pr-3">Motif</th>
                      </tr>
                    </thead>
                    <tbody>
                      {basculeReport.invalides.length === 0 ? (
                        <tr>
                          <td
                            colSpan={2}
                            className="py-3 text-xs text-muted-foreground"
                          >
                            Aucune ligne invalide.
                          </td>
                        </tr>
                      ) : (
                        basculeReport.invalides.map((inv, i) => (
                          <tr key={i} className="border-b border-border/30">
                            <td className="py-2 pr-3 font-mono text-xs">
                              {inv.raw || "—"}
                            </td>
                            <td className="py-2 pr-3 text-xs text-muted-foreground">
                              {inv.motif}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border/50">
                        <th className="py-2 pr-3" />
                        <th className="py-2 pr-3">NICAD ancien</th>
                        <th className="py-2 pr-3">→ Cible 2026</th>
                        <th className="py-2 pr-3">
                          Commune · Région/Département
                        </th>
                        <th className="py-2 pr-3">Statut</th>
                        <th className="py-2 pr-3">Réserves</th>
                        {resultatsExecution.size > 0 && (
                          <th className="py-2 pr-3">Résultat</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {basculeReport.items
                        .filter((item) => itemMatchesFiltre(item, filtreStatut))
                        .map((item) => {
                          const selectionnable = peutSelectionnerLigne(item);
                          const resultat = resultatsExecution.get(
                            item.nicadAncien,
                          );
                          return (
                            <tr
                              key={item.nicadAncien}
                              className={`border-b border-border/30 ${item.dejaAJour ? "opacity-50" : ""}`}
                            >
                              <td className="py-2 pr-3">
                                {selectionnable ? (
                                  <input
                                    type="checkbox"
                                    checked={selectedForBascule.has(
                                      item.nicadAncien,
                                    )}
                                    onChange={() =>
                                      toggleSelected(item.nicadAncien)
                                    }
                                  />
                                ) : !item.dejaAJour && item.proposition ? (
                                  <span
                                    className="text-xs text-muted-foreground"
                                    title="Section 2026 non confirmée par recouvrement spatial — à vérifier manuellement avant basculement (page Basculement)."
                                  >
                                    —
                                  </span>
                                ) : null}
                              </td>
                              <td className="py-2 pr-3 font-mono text-xs">
                                {item.nicadAncien}
                              </td>
                              <td className="py-2 pr-3 font-mono text-xs">
                                {item.proposition
                                  ? `${item.proposition.syscolNouveau}${item.proposition.sectionNouvelle ? " / section " + item.proposition.sectionNouvelle : ""}`
                                  : "—"}
                              </td>
                              <td className="py-2 pr-3 text-xs text-muted-foreground">
                                {item.commune2013 &&
                                  `${item.commune2013.nom} (${item.commune2013.region ?? "—"} · ${item.commune2013.departement ?? "—"})`}
                                {item.commune2013 && item.commune2026 && " → "}
                                {item.commune2026 &&
                                  `${item.commune2026.nom} (${item.commune2026.region ?? "—"} · ${item.commune2026.departement ?? "—"})`}
                                {!item.commune2013 && !item.commune2026 && "—"}
                              </td>
                              <td className="py-2 pr-3 text-xs text-muted-foreground">
                                {item.dejaAJour
                                  ? "Déjà 2026"
                                  : item.clean
                                    ? "Sans réserve"
                                    : !selectionnable
                                      ? "Section à vérifier manuellement"
                                      : "Avec réserve"}
                              </td>
                              <td className="py-2 pr-3 text-xs text-muted-foreground">
                                {item.flags.length > 0
                                  ? item.flags.join(" · ")
                                  : "—"}
                              </td>
                              {resultatsExecution.size > 0 && (
                                <td className="py-2 pr-3 text-xs">
                                  {resultat ? (
                                    resultat.success ? (
                                      <span className="text-emerald-600">
                                        ✓ basculé
                                        {resultat.nicadNouveau
                                          ? ` → ${resultat.nicadNouveau}`
                                          : ""}
                                      </span>
                                    ) : (
                                      <span className="text-destructive">
                                        ✗ {resultat.error ?? "échec"}
                                      </span>
                                    )
                                  ) : (
                                    "—"
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="historique-migrations">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Historique des migrations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chargementHistorique ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement de
              l&apos;historique…
            </p>
          ) : historique.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucune migration effectuée pour l&apos;instant.
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {historique.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{job.fileName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString("fr-FR")}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {job.totalBuilt.toLocaleString("fr-FR")} NICAD identifié(s)
                    </span>
                    <span
                      title={job.error ?? undefined}
                      className={
                        job.status === "completed"
                          ? "rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-500"
                          : job.status === "failed" || job.status === "cancelled"
                            ? "rounded bg-rose-500/15 px-2 py-0.5 text-rose-500"
                            : "rounded bg-amber-500/15 px-2 py-0.5 text-amber-500"
                      }
                    >
                      {job.status}
                    </span>
                    {job.status === "completed" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Consulter"
                        disabled={consultationEnCours === job.id}
                        onClick={() => consulterJob(job.id)}
                      >
                        {consultationEnCours === job.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Supprimer"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setJobASupprimer({ id: job.id, fileName: job.fileName })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={jobASupprimer !== null}
        title="Supprimer cette migration ?"
        description={
          <>
            « {jobASupprimer?.fileName} » sera supprimé définitivement, y
            compris le fichier importé et le rapport associé sur le
            serveur. Cette action est irréversible.
          </>
        }
        confirmLabel={suppressionEnCours ? "Suppression…" : "Supprimer"}
        onConfirm={confirmerSuppression}
        onCancel={() => setJobASupprimer(null)}
      />

      {pendingInventory && (
        <FieldMappingModal
          fileName={pendingInventory.fileName}
          targetFields={pendingInventory.targetFields}
          availableFields={pendingInventory.fields}
          proposedMapping={pendingInventory.proposedMapping}
          onCancel={() => setPendingInventory(null)}
          onConfirm={(mapping) => void startBasculeJob(mapping)}
        />
      )}
    </div>
  );
}
