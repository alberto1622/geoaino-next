"use client";
import { PageTitle } from "@/components/PageTitle";

import { useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Layers, Play, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import FieldMappingModal from "@/components/FieldMappingModal";
import { JobProgressSteps, type JobProgressStep } from "@/components/import/JobProgressSteps";
import { previewToutes, executerCommune, executerToutes, executerBasculementListe } from "../_actions/migration";
import type { BasculeNicadItem, BasculeNicadReport } from "@/lib/import/run-bascule-job";

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
type ResultatLigne = { success: boolean; nicadNouveau?: string; error?: string };

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

export default function MigrationPage() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingInventory, setPendingInventory] = useState<{
    fileKey: string;
    fileName: string;
    targetFields: { key: string; label: string; aliases: string[]; required?: boolean }[];
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
  const [basculeReport, setBasculeReport] = useState<BasculeReport | null>(null);
  const [selectedForBascule, setSelectedForBascule] = useState<Set<string>>(new Set());
  const [executingBascule, setExecutingBascule] = useState(false);
  const [executionProgress, setExecutionProgress] = useState<{ chunk: number; total: number } | null>(null);
  const [resultatsExecution, setResultatsExecution] = useState<Map<string, ResultatLigne>>(new Map());

  function reload() {
    startTransition(async () => {
      try {
        setPreviews((await previewToutes()) as Preview[]);
      } catch {
        toast.error("Action non autorisée ou erreur de prévisualisation.");
      }
    });
  }

  useEffect(reload, []);

  const totalParcelles = previews.reduce((s, p) => s + p.nbParcelles, 0);

  function migrerCommune(p: Preview) {
    if (!p.syscol2026) return;
    setBusy(p.syscol2013);
    startTransition(async () => {
      try {
        const res = await executerCommune({ syscol2013: p.syscol2013, syscol2026: p.syscol2026! });
        toast.success(`${p.nomCommune2013} : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`);
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
        toast.success(`Migration globale : ${res.nbMigres} migré(s), ${res.nbEchecs} échec(s).`);
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
    const shpFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".dbf"));
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
    try {
      const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: fd });
      const inv = await res.json();
      if (!res.ok) throw new Error(inv.error || "Inventaire échoué");
      setPendingInventory(inv);
    } catch (err) {
      toast.error(String(err));
    } finally {
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
      setBasculeJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
    }
  }

  useEffect(() => {
    if (!basculeJob || (basculeJob.status !== "pending" && basculeJob.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${basculeJob.id}`);
        const j = await res.json();
        setBasculeJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, error: j.error });
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
    if (!item.clean && !item.proposition.sectionNouvelle && item.sectionExisteEn2026 !== true) return false;
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
    setSelectedForBascule(new Set(basculeReport.items.filter((i) => i.clean).map((i) => i.nicadAncien)));
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
    setExecutionProgress(chunks.length > 1 ? { chunk: 0, total: chunks.length } : null);
    startTransition(async () => {
      let nbMigres = 0;
      let nbEchecs = 0;
      const resultatsParNicad = new Map<string, ResultatLigne>();
      try {
        for (let c = 0; c < chunks.length; c++) {
          setExecutionProgress(chunks.length > 1 ? { chunk: c + 1, total: chunks.length } : null);
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
            <h1 className="text-2xl font-bold tracking-tight">Migration en masse</h1>
            <p className="text-sm text-muted-foreground">
              Basculement des NICAD Syscol 2013 → 2026 par commune ou en global.
            </p>
          </div>
        </div>
        <Button onClick={migrerToutes} disabled={pending || previews.length === 0} className="gap-2">
          <Play className="h-4 w-4" /> Tout migrer
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prévisualisation</CardTitle>
        </CardHeader>
        <CardContent>
          {previews.length === 0 ? (
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
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Importer un shapefile (NICAD)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sélectionnez un shapefile (.shp + .dbf) portant une colonne NICAD
            2013 — la cible 2026 de chaque NICAD (commune, section, cas
            simple ou complexe) sera identifiée automatiquement avant tout
            basculement.
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
            disabled={!!basculeJob && basculeJob.status !== "completed" && basculeJob.status !== "failed"}
            className="gap-2"
          >
            <Upload className="h-4 w-4" /> Choisir un shapefile
          </Button>

          {basculeJob && (basculeJob.status === "pending" || basculeJob.status === "running") && (
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
                <span>{basculeReport.stats.clean} sans drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.avecDrapeaux} avec drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.dejaAJour} déjà à jour</span>
                <span>·</span>
                <span>{basculeReport.stats.invalides} invalide(s)</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAllClean}>
                  Sélectionner les lignes sans drapeau
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
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border/50">
                      <th className="py-2 pr-3" />
                      <th className="py-2 pr-3">NICAD ancien</th>
                      <th className="py-2 pr-3">→ Cible 2026</th>
                      <th className="py-2 pr-3">Statut</th>
                      <th className="py-2 pr-3">Drapeaux</th>
                      {resultatsExecution.size > 0 && <th className="py-2 pr-3">Résultat</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {basculeReport.items.map((item) => {
                      const selectionnable = peutSelectionnerLigne(item);
                      const resultat = resultatsExecution.get(item.nicadAncien);
                      return (
                        <tr
                          key={item.nicadAncien}
                          className={`border-b border-border/30 ${item.dejaAJour ? "opacity-50" : ""}`}
                        >
                          <td className="py-2 pr-3">
                            {selectionnable ? (
                              <input
                                type="checkbox"
                                checked={selectedForBascule.has(item.nicadAncien)}
                                onChange={() => toggleSelected(item.nicadAncien)}
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
                          <td className="py-2 pr-3 font-mono text-xs">{item.nicadAncien}</td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {item.proposition
                              ? `${item.proposition.syscolNouveau}${item.proposition.sectionNouvelle ? " / section " + item.proposition.sectionNouvelle : ""}`
                              : "—"}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {item.dejaAJour
                              ? "Déjà 2026"
                              : item.clean
                                ? "Sans drapeau"
                                : !selectionnable
                                  ? "Section à vérifier manuellement"
                                  : "Avec drapeau"}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {item.flags.length > 0 ? item.flags.join(" · ") : "—"}
                          </td>
                          {resultatsExecution.size > 0 && (
                            <td className="py-2 pr-3 text-xs">
                              {resultat ? (
                                resultat.success ? (
                                  <span className="text-emerald-600">
                                    ✓ basculé{resultat.nicadNouveau ? ` → ${resultat.nicadNouveau}` : ""}
                                  </span>
                                ) : (
                                  <span className="text-destructive">✗ {resultat.error ?? "échec"}</span>
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
            </div>
          )}
        </CardContent>
      </Card>

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
