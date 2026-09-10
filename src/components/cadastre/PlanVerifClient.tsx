"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ClipboardPaste,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Info,
  Loader2,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { parseBornes, formaterBornes } from "@/lib/cadastre/verif/parse";
import {
  appliquerCorrection,
  verifier,
  VERDICT_LIBELLE,
  gonEnDegres,
} from "@/lib/cadastre/verif/core";
import { genererPv } from "@/lib/cadastre/verif-pdf";
import {
  Anomalie,
  Borne,
  CrsSource,
  ErreurLigne,
  Severite,
  SourceVerif,
  TOLERANCE_PCT_DEFAUT,
  TOLERANCE_PLANCHER_M2_DEFAUT,
  VerifRapport,
} from "@/lib/cadastre/verif/types";

const PlanVerifMap = dynamic(() => import("./PlanVerifMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-md border bg-muted/40 text-sm text-muted-foreground">
      Chargement de la carte…
    </div>
  ),
});

type Onglet = "coller" | "grille" | "fichier" | "nicad";

const ONGLETS: Array<{ cle: Onglet; libelle: string; icone: typeof Table2 }> = [
  { cle: "coller", libelle: "Coller", icone: ClipboardPaste },
  { cle: "grille", libelle: "Grille", icone: Table2 },
  { cle: "fichier", libelle: "Fichier", icone: FileSpreadsheet },
  { cle: "nicad", libelle: "NICAD", icone: Search },
];

const LIBELLE_CRS: Record<CrsSource, string> = {
  "EPSG:32628": "EPSG:32628 — UTM 28N (RRS04)",
  "EPSG:31028": "EPSG:31028 — Yoff / UTM 28N (ancien datum)",
};

const STYLE_VERDICT = {
  CONFORME: {
    cadre: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icone: CheckCircle2,
  },
  CONFORME_AVEC_RESERVE: {
    cadre: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icone: AlertTriangle,
  },
  NON_CONFORME: {
    cadre: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
    icone: XCircle,
  },
} as const;

const ICONE_SEVERITE: Record<Severite, typeof Info> = {
  erreur: XCircle,
  avertissement: AlertTriangle,
  info: Info,
};

const COULEUR_SEVERITE: Record<Severite, string> = {
  erreur: "text-red-600 dark:text-red-400",
  avertissement: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
};

const LIBELLE_CORRECTION = {
  PERMUTER_XY: "Permuter X et Y",
  DIVISER_1000: "Diviser par 1000",
  INVERSER_SENS: "Inverser le sens",
  RENUMEROTER: "Renuméroter",
} as const;

const LIBELLE_SOURCE: Record<SourceVerif, string> = {
  saisie: "Saisie manuelle / collage",
  fichier: "Fichier importé (CSV / TXT)",
  referentiel: "Bornes reprises du référentiel (NICAD)",
};

/** Une ligne de la grille : les champs restent des chaînes tant qu'on édite. */
type LigneGrille = { pt: string; x: string; y: string };

const versLignes = (bornes: Borne[]): LigneGrille[] =>
  bornes.map((b) => ({ pt: b.pt, x: String(b.x), y: String(b.y) }));

const LIGNE_VIDE: LigneGrille = { pt: "", x: "", y: "" };

/** Petit wrapper `fetch` : lève une Error dont `.message` porte le message serveur. */
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Erreur ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

interface PlanVerifClientProps {
  /** Nom de l'opérateur, reporté sur le PV. */
  operateur?: string;
}

export default function PlanVerifClient({ operateur }: PlanVerifClientProps) {
  const [onglet, setOnglet] = useState<Onglet>("coller");
  const [colle, setColle] = useState("");
  const [lignes, setLignes] = useState<LigneGrille[]>([{ ...LIGNE_VIDE }]);
  const [erreursParse, setErreursParse] = useState<ErreurLigne[]>([]);

  const [crsSource, setCrsSource] = useState<CrsSource>("EPSG:32628");
  const [nicad, setNicad] = useState("");
  const [superficieDeclaree, setSuperficieDeclaree] = useState("");
  const [tolerancePct, setTolerancePct] = useState(String(TOLERANCE_PCT_DEFAUT));
  const [tolerancePlancher, setTolerancePlancher] = useState(
    String(TOLERANCE_PLANCHER_M2_DEFAUT),
  );

  const [source, setSource] = useState<SourceVerif>("saisie");
  const [avertissementImport, setAvertissementImport] = useState<string | null>(null);

  const [enGon, setEnGon] = useState(true);
  const [surlignees, setSurlignees] = useState<number[]>([]);
  const [importEnCours, setImportEnCours] = useState(false);
  const [rechercheNicad, setRechercheNicad] = useState(false);
  const [enregistrement, setEnregistrement] = useState(false);
  const [dernierPv, setDernierPv] = useState<{ id: number; rapport: VerifRapport } | null>(
    null,
  );

  const inputFichier = useRef<HTMLInputElement>(null);
  const nicadRechercheRef = useRef("");

  // --- État dérivé -----------------------------------------------------------

  /** Bornes exploitables : les lignes incomplètes de la grille sont ignorées. */
  const bornes = useMemo<Borne[]>(() => {
    const out: Borne[] = [];
    lignes.forEach((l, i) => {
      const x = Number(String(l.x).replace(",", "."));
      const y = Number(String(l.y).replace(",", "."));
      if (!l.x.trim() || !l.y.trim()) return;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      out.push({ pt: l.pt.trim() || `B${i + 1}`, x, y });
    });
    return out;
  }, [lignes]);

  const nombre = (s: string, defaut: number) => {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : defaut;
  };

  const declaree = useMemo(() => {
    const n = Number(superficieDeclaree.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [superficieDeclaree]);

  /**
   * Rapport recalculé à chaque frappe. C'est un **aperçu** : le rapport qui
   * fait foi est celui que le serveur recalcule à l'enregistrement, avec le
   * même code (`src/lib/cadastre/verif/core.ts`).
   */
  const rapport = useMemo(() => {
    if (bornes.length < 3) return null;
    return verifier({
      bornes,
      crsSource,
      superficieDeclaree: declaree,
      tolerancePct: nombre(tolerancePct, TOLERANCE_PCT_DEFAUT),
      tolerancePlancherM2: nombre(tolerancePlancher, TOLERANCE_PLANCHER_M2_DEFAUT),
    });
  }, [bornes, crsSource, declaree, tolerancePct, tolerancePlancher]);

  // --- Actions -------------------------------------------------------------

  const chargerBornes = useCallback(
    (nouvelles: Borne[], erreurs: ErreurLigne[] = []) => {
      setLignes(nouvelles.length ? versLignes(nouvelles) : [{ ...LIGNE_VIDE }]);
      setErreursParse(erreurs);
      setDernierPv(null);
    },
    [],
  );

  const analyserColle = useCallback(() => {
    const { bornes: b, erreurs } = parseBornes(colle);
    if (!b.length) {
      toast.error("Aucune borne n'a pu être lue dans ce texte.");
      setErreursParse(erreurs);
      return;
    }
    chargerBornes(b, erreurs);
    setSource("saisie");
    setAvertissementImport(null);
    setOnglet("grille");
    toast.success(
      `${b.length} borne${b.length > 1 ? "s" : ""} chargée${b.length > 1 ? "s" : ""}${
        erreurs.length ? ` — ${erreurs.length} ligne(s) rejetée(s)` : ""
      }.`,
    );
  }, [colle, chargerBornes]);

  const importer = useCallback(
    async (fichier: File) => {
      setImportEnCours(true);
      setAvertissementImport(null);
      try {
        const form = new FormData();
        form.append("file", fichier);
        const res = await apiJson<{
          bornes: Borne[];
          source: SourceVerif;
          erreurs: ErreurLigne[];
          avertissement?: string;
        }>("/api/cadastre/verif/import", { method: "POST", body: form });

        setSource(res.source);
        setAvertissementImport(res.avertissement ?? null);

        if (!res.bornes.length) {
          setErreursParse(res.erreurs);
          toast.error(res.avertissement ?? "Aucune borne extraite de ce fichier.");
          return;
        }
        chargerBornes(res.bornes, res.erreurs);
        setOnglet("grille");
        toast.success(`${res.bornes.length} borne(s) importée(s).`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "L'import a échoué.");
      } finally {
        setImportEnCours(false);
      }
    },
    [chargerBornes],
  );

  const rechercherNicad = useCallback(async () => {
    const cible = nicadRechercheRef.current.trim();
    if (!cible) {
      toast.error("Saisissez un NICAD à rechercher.");
      return;
    }
    setRechercheNicad(true);
    setAvertissementImport(null);
    try {
      const res = await apiJson<{
        bornes: Borne[];
        superficieDeclaree?: number;
        syscolCommune: string;
        numSection: string;
        numParcelle: string;
      }>(`/api/cadastre/verif/referentiel?nicad=${encodeURIComponent(cible)}`);

      chargerBornes(res.bornes);
      setSource("referentiel");
      setNicad(cible);
      if (res.superficieDeclaree != null) {
        setSuperficieDeclaree(String(res.superficieDeclaree));
      }
      setAvertissementImport(
        "Bornes reprises de la géométrie actuellement enregistrée pour ce NICAD (référentiel CadParcelle) — commodité de saisie, aucun document n'a été lu.",
      );
      setOnglet("grille");
      toast.success(
        `${res.bornes.length} borne(s) — parcelle ${res.syscolCommune}/${res.numSection}/${res.numParcelle}.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Recherche impossible.");
    } finally {
      setRechercheNicad(false);
    }
  }, [chargerBornes]);

  const corriger = useCallback(
    (anomalie: Anomalie) => {
      if (!anomalie.correction) return;
      setLignes(versLignes(appliquerCorrection(bornes, anomalie.correction)));
      setDernierPv(null);
      toast.success(`${LIBELLE_CORRECTION[anomalie.correction]} : appliqué.`);
    },
    [bornes],
  );

  const enregistrer = useCallback(async () => {
    if (!rapport) return;
    setEnregistrement(true);
    try {
      const res = await apiJson<{ id: number; rapport: VerifRapport }>(
        "/api/cadastre/verif",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bornes,
            crsSource,
            nicad: nicad.trim() || undefined,
            superficieDeclaree: declaree,
            tolerancePct: nombre(tolerancePct, TOLERANCE_PCT_DEFAUT),
            tolerancePlancherM2: nombre(tolerancePlancher, TOLERANCE_PLANCHER_M2_DEFAUT),
            source,
          }),
        },
      );
      setDernierPv(res);
      toast.success(`Vérification n° ${res.id} enregistrée.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "L'enregistrement a échoué.");
    } finally {
      setEnregistrement(false);
    }
  }, [
    rapport,
    bornes,
    crsSource,
    nicad,
    declaree,
    tolerancePct,
    tolerancePlancher,
    source,
  ]);

  const telechargerPv = useCallback(async () => {
    if (!dernierPv) return;
    try {
      await genererPv(dernierPv.rapport, {
        operateur: operateur ?? "",
        nicad: nicad.trim() || null,
        crsSource,
        source,
        date: new Date(),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Génération du PV impossible.");
    }
  }, [dernierPv, operateur, nicad, crsSource, source]);

  const majLigne = (index: number, champ: keyof LigneGrille, valeur: string) => {
    setLignes((prev) => prev.map((l, i) => (i === index ? { ...l, [champ]: valeur } : l)));
    setDernierPv(null);
  };

  // --- Rendu -----------------------------------------------------------------

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <FileCheck2 className="h-6 w-6 text-primary" />
          Vérifier des bornes
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Reconstruit une parcelle à partir de son tableau de coordonnées X/Y et en
          contrôle la cohérence géométrique (auto-intersection, superficie, numérotation…)
          en UTM 28N. Le résultat serveur fait foi ; il est enregistré et sert de base au
          procès-verbal.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ------------------------------------------------ Colonne saisie */}
        <section className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
            {ONGLETS.map(({ cle, libelle, icone: Icone }) => (
              <button
                key={cle}
                type="button"
                onClick={() => setOnglet(cle)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium transition",
                  onglet === cle
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icone className="h-3.5 w-3.5" />
                {libelle}
              </button>
            ))}
          </div>

          {onglet === "coller" && (
            <div className="space-y-2">
              <Label htmlFor="verif-colle">Tableau de coordonnées</Label>
              <textarea
                id="verif-colle"
                value={colle}
                onChange={(e) => setColle(e.target.value)}
                rows={10}
                spellCheck={false}
                placeholder={
                  "B1\t240123.4567\t1630987.6543\nB2\t240200.5000\t1631000.2500\n…"
                }
                className="w-full rounded-md border bg-background p-2 font-mono text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Tabulations, points-virgules, virgules ou espaces ; décimale « . » ou
                « , ». L&apos;en-tête et la mention « Système de coordonnée : RRS04 »
                sont ignorés.
              </p>
              <Button
                type="button"
                onClick={analyserColle}
                disabled={!colle.trim()}
                className="w-full"
              >
                <Wand2 className="mr-2 h-4 w-4" />
                Analyser le tableau
              </Button>
            </div>
          )}

          {onglet === "grille" && (
            <div className="space-y-2">
              <div className="max-h-[340px] overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-1.5 text-left font-semibold">Pts</th>
                      <th className="p-1.5 text-left font-semibold">X (m)</th>
                      <th className="p-1.5 text-left font-semibold">Y (m)</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {lignes.map((l, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-1">
                          <input
                            value={l.pt}
                            onChange={(e) => majLigne(i, "pt", e.target.value)}
                            placeholder={`B${i + 1}`}
                            className="w-14 rounded border-none bg-transparent px-1 py-1 font-mono outline-none focus:bg-muted"
                          />
                        </td>
                        <td className="p-1">
                          <input
                            value={l.x}
                            onChange={(e) => majLigne(i, "x", e.target.value)}
                            inputMode="decimal"
                            className="w-full rounded border-none bg-transparent px-1 py-1 font-mono outline-none focus:bg-muted"
                          />
                        </td>
                        <td className="p-1">
                          <input
                            value={l.y}
                            onChange={(e) => majLigne(i, "y", e.target.value)}
                            inputMode="decimal"
                            className="w-full rounded border-none bg-transparent px-1 py-1 font-mono outline-none focus:bg-muted"
                          />
                        </td>
                        <td className="p-1">
                          <button
                            type="button"
                            aria-label={`Supprimer la ligne ${i + 1}`}
                            onClick={() => {
                              setLignes((prev) =>
                                prev.length > 1
                                  ? prev.filter((_, j) => j !== i)
                                  : [{ ...LIGNE_VIDE }],
                              );
                              setDernierPv(null);
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLignes((prev) => [...prev, { ...LIGNE_VIDE }])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Ajouter une borne
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={bornes.length < 3}
                  onClick={() => {
                    setLignes(versLignes(appliquerCorrection(bornes, "INVERSER_SENS")));
                    setDernierPv(null);
                    toast.success("Sens de parcours inversé.");
                  }}
                >
                  <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
                  Inverser le sens
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!bornes.length}
                  onClick={() => {
                    navigator.clipboard.writeText(formaterBornes(bornes));
                    toast.success("Tableau copié dans le presse-papiers.");
                  }}
                >
                  Copier le tableau
                </Button>
              </div>
            </div>
          )}

          {onglet === "fichier" && (
            <div className="space-y-2">
              <Label htmlFor="verif-fichier">Fichier CSV ou TXT</Label>
              <input
                ref={inputFichier}
                id="verif-fichier"
                type="file"
                accept=".csv,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importer(f);
                  e.target.value = "";
                }}
                className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium"
              />
              <p className="text-xs text-muted-foreground">
                Une ligne par borne, colonnes Pts / X / Y. Pour un classeur Excel, copiez
                les cellules et utilisez l&apos;onglet « Coller » : le presse-papiers Excel
                est déjà au bon format.
              </p>
            </div>
          )}

          {onglet === "nicad" && (
            <div className="space-y-2">
              <Label htmlFor="verif-nicad-recherche">
                NICAD d&apos;une parcelle du référentiel
              </Label>
              <div className="flex gap-2">
                <Input
                  id="verif-nicad-recherche"
                  defaultValue=""
                  onChange={(e) => {
                    nicadRechercheRef.current = e.target.value;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rechercherNicad();
                  }}
                  placeholder="16 caractères"
                />
                <Button
                  type="button"
                  onClick={rechercherNicad}
                  disabled={rechercheNicad}
                >
                  {rechercheNicad ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Reprend les sommets de la géométrie enregistrée pour ce NICAD (table
                CadParcelle), reprojetés en UTM 28N, et pré-remplit la superficie
                déclarée. Commodité de saisie — aucune lecture de document.
              </p>
            </div>
          )}

          {importEnCours && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Lecture du fichier…
            </p>
          )}

          {avertissementImport && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              {avertissementImport}
            </p>
          )}

          {erreursParse.length > 0 && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2">
              <p className="mb-1 text-xs font-semibold text-red-700 dark:text-red-400">
                {erreursParse.length} ligne(s) illisible(s), ignorée(s)
              </p>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {erreursParse.slice(0, 6).map((e) => (
                  <li key={e.ligne} className="font-mono">
                    ligne {e.ligne} : « {e.contenu.trim().slice(0, 40)} » — {e.motif}
                  </li>
                ))}
                {erreursParse.length > 6 && (
                  <li>… et {erreursParse.length - 6} autre(s).</li>
                )}
              </ul>
            </div>
          )}

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="verif-crs">Système de coordonnées</Label>
              <select
                id="verif-crs"
                value={crsSource}
                onChange={(e) => setCrsSource(e.target.value as CrsSource)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {(Object.keys(LIBELLE_CRS) as CrsSource[]).map((c) => (
                  <option key={c} value={c}>
                    {LIBELLE_CRS[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="verif-nicad">NICAD (facultatif)</Label>
              <Input
                id="verif-nicad"
                value={nicad}
                onChange={(e) => setNicad(e.target.value)}
                placeholder="documentaire"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="verif-superficie">Superficie déclarée (m²)</Label>
              <Input
                id="verif-superficie"
                value={superficieDeclaree}
                onChange={(e) => setSuperficieDeclaree(e.target.value)}
                inputMode="decimal"
                placeholder="portée sur le plan"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="verif-tol-pct">Tolérance (%)</Label>
              <Input
                id="verif-tol-pct"
                value={tolerancePct}
                onChange={(e) => setTolerancePct(e.target.value)}
                inputMode="decimal"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="verif-tol-plancher">Plancher (m²)</Label>
              <Input
                id="verif-tol-plancher"
                value={tolerancePlancher}
                onChange={(e) => setTolerancePlancher(e.target.value)}
                inputMode="decimal"
                className="mt-1"
              />
            </div>
          </div>

          <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Origine : </span>
            {LIBELLE_SOURCE[source]}
          </div>

          <Button
            type="button"
            className="w-full"
            disabled={!rapport || enregistrement}
            onClick={enregistrer}
          >
            {enregistrement ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Enregistrer la vérification
          </Button>

          {dernierPv && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-2 text-xs">
              <span>Vérification n° {dernierPv.id} enregistrée.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={telechargerPv}
              >
                <Download className="mr-1.5 h-3 w-3" />
                Télécharger le procès-verbal
              </Button>
            </div>
          )}
        </section>

        {/* ----------------------------------------------- Colonne résultat */}
        <section className="space-y-4">
          {rapport ? (
            <>
              {(() => {
                const style = STYLE_VERDICT[rapport.verdict];
                const Icone = style.icone;
                const erreurs = rapport.anomalies.filter(
                  (a) => a.severite === "erreur",
                ).length;
                const avertissements = rapport.anomalies.filter(
                  (a) => a.severite === "avertissement",
                ).length;
                return (
                  <div
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3",
                      style.cadre,
                    )}
                  >
                    <Icone className="h-6 w-6 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-semibold">{VERDICT_LIBELLE[rapport.verdict]}</p>
                      <p className="text-xs opacity-80">
                        {erreurs} erreur{erreurs > 1 ? "s" : ""} · {avertissements}{" "}
                        avertissement{avertissements > 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                );
              })()}

              <div className="h-[320px] sm:h-[380px]">
                <PlanVerifMap
                  geometry={rapport.geometry}
                  bornes={rapport.bornes}
                  crsSource={crsSource}
                  surlignees={surlignees}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metrique
                  libelle="Superficie"
                  valeur={`${rapport.superficieM2.toFixed(2)} m²`}
                  detail={`${(rapport.superficieM2 / 100).toFixed(2)} ares · ${(rapport.superficieM2 / 10000).toFixed(4)} ha`}
                />
                <Metrique
                  libelle="Périmètre"
                  valeur={`${rapport.perimetreM.toFixed(2)} m`}
                />
                <Metrique
                  libelle="Bornes"
                  valeur={String(rapport.bornes.length)}
                  detail={`parcours ${rapport.sensHoraire ? "horaire" : "anti-horaire"}`}
                />
                <Metrique
                  libelle="Écart de superficie"
                  valeur={
                    rapport.ecartSuperficie
                      ? `${rapport.ecartSuperficie.absoluM2.toFixed(2)} m²`
                      : "—"
                  }
                  detail={
                    rapport.ecartSuperficie
                      ? `${rapport.ecartSuperficie.relatifPct.toFixed(2)} % · tolérance ${rapport.ecartSuperficie.toleranceM2.toFixed(2)} m²`
                      : "aucune superficie déclarée"
                  }
                />
              </div>

              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b p-3">
                  <h2 className="text-sm font-semibold">
                    Côtés, longueurs et gisements
                  </h2>
                  <button
                    type="button"
                    onClick={() => setEnGon((v) => !v)}
                    className="rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {enGon ? "gon" : "degrés"}
                  </button>
                </div>
                <div className="max-h-[240px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="p-2 text-left font-semibold">De</th>
                        <th className="p-2 text-left font-semibold">Vers</th>
                        <th className="p-2 text-right font-semibold">Longueur (m)</th>
                        <th className="p-2 text-right font-semibold">
                          Gisement ({enGon ? "gon" : "°"})
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rapport.cotes.map((c, i) => (
                        <tr
                          key={`${c.de}-${c.vers}`}
                          className="border-t"
                          onMouseEnter={() =>
                            setSurlignees([i, (i + 1) % rapport.bornes.length])
                          }
                          onMouseLeave={() => setSurlignees([])}
                        >
                          <td className="p-2 font-mono">{c.de}</td>
                          <td className="p-2 font-mono">{c.vers}</td>
                          <td className="p-2 text-right font-mono">
                            {c.longueur.toFixed(2)}
                          </td>
                          <td className="p-2 text-right font-mono">
                            {(enGon ? c.gisement : gonEnDegres(c.gisement)).toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border bg-card p-3">
                <h2 className="mb-2 text-sm font-semibold">
                  Anomalies ({rapport.anomalies.length})
                </h2>
                {rapport.anomalies.length === 0 ? (
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    Aucune anomalie : la géométrie est cohérente
                    {rapport.ecartSuperficie ? " et la superficie conforme" : ""}.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {rapport.anomalies.map((a, i) => {
                      const Icone = ICONE_SEVERITE[a.severite];
                      return (
                        <li
                          key={`${a.code}-${i}`}
                          onMouseEnter={() => setSurlignees(a.bornes ?? [])}
                          onMouseLeave={() => setSurlignees([])}
                          className="flex items-start gap-2 rounded-md p-1.5 text-xs hover:bg-muted/60"
                        >
                          <Icone
                            className={cn(
                              "mt-0.5 h-3.5 w-3.5 shrink-0",
                              COULEUR_SEVERITE[a.severite],
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p>{a.message}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {a.code}
                            </p>
                          </div>
                          {a.correction && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 shrink-0 px-2 text-[11px]"
                              onClick={() => corriger(a)}
                            >
                              {LIBELLE_CORRECTION[a.correction]}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-[420px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 p-6 text-center">
              <FileCheck2 className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm font-medium">Aucune parcelle à vérifier</p>
              <p className="max-w-md text-xs text-muted-foreground">
                Collez un tableau de coordonnées, importez un fichier CSV/TXT, recherchez
                un NICAD, ou saisissez au moins trois bornes dans la grille.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metrique({
  libelle,
  valeur,
  detail,
}: {
  libelle: string;
  valeur: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {libelle}
      </p>
      <p className="mt-0.5 font-mono text-base font-semibold">{valeur}</p>
      {detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
