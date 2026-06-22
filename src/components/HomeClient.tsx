"use client";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload, MapPin, Brain, Shield, FileText, Activity,
  Layers, AlertTriangle, CheckCircle, Globe, Database,
  ArrowRight, BarChart2, History, ChevronRight, Cpu,
  Lock, TrendingUp, Wrench, Zap
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavBar } from "@/components/NavBar";
import { toNum } from "@/lib/utils";

const FORMATS = ["SHP", "GeoJSON", "DGN v7", "DXF", "KML", "CSV"];

const FEATURES = [
  { icon: Brain, title: "Agent IA Expert", desc: "GPT-4o analyse chaque parcelle et génère des rapports d'expertise sans hallucinations", color: "oklch(0.65 0.18 220)" },
  { icon: Layers, title: "Détection Topologique", desc: "Chevauchements, slivers, gaps, doublons NICAD — détectés avec précision mathématique", color: "oklch(0.60 0.22 25)" },
  { icon: MapPin, title: "Carte Interactive", desc: "Visualisation en temps réel des erreurs sur carte avec couches dynamiques", color: "oklch(0.70 0.18 140)" },
  { icon: Shield, title: "Limites Administratives", desc: "Validation automatique contre les 14 régions du Sénégal", color: "oklch(0.65 0.20 300)" },
  { icon: FileText, title: "Rapports PDF", desc: "Rapports d'expert complets avec cartes annotées et recommandations correctives", color: "oklch(0.70 0.18 55)" },
  { icon: Wrench, title: "Correction Automatique", desc: "Génère un GeoJSON corrigé (doublons supprimés, NICAD assignés, géométries invalides retirées)", color: "oklch(0.65 0.22 145)" },
];

const ERROR_TYPES = [
  { label: "Chevauchements", sublabel: "Overlaps", color: "#ef4444" },
  { label: "Espaces vides", sublabel: "Gaps", color: "#f59e0b" },
  { label: "Résidus", sublabel: "Slivers", color: "#a855f7" },
  { label: "Doublons NICAD", sublabel: "Duplicates", color: "#3b82f6" },
  { label: "Géom. invalides", sublabel: "Invalid Geom.", color: "#ec4899" },
  { label: "Croisements limites", sublabel: "Boundary Cross", color: "#06b6d4" },
];

const WORKFLOW_STEPS = [
  { step: "01", title: "Chargez votre fichier", desc: "SHP, GeoJSON, DGN, DXF, KML ou CSV — le système détecte automatiquement le format", icon: Upload },
  { step: "02", title: "Analyse IA automatique", desc: "Le moteur topologique analyse chaque parcelle et détecte toutes les anomalies", icon: Cpu },
  { step: "03", title: "Visualisation sur carte", desc: "Chaque erreur est localisée sur la carte avec code couleur et description", icon: MapPin },
  { step: "04", title: "Rapport d'expert", desc: "L'agent IA génère un rapport professionnel avec recommandations correctives", icon: FileText },
];

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  stats: { totalAnalyses: number; totalParcelles: number; avgConformity: number };
}

type UploadStep = "reading" | "analyzing" | "ai" | "done" | null;

interface AnalysisResult {
  id: number;
  totalFeatures: number;
  errorCount: number;
  conformityScore: number;
}

export default function HomeClient({ user, stats }: Props) {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

  const handleFiles = useCallback(async (fileList: File[]) => {
    if (!fileList.length || isUploading) return;

    const mainFile = fileList.find(
      (f) => !f.name.toLowerCase().endsWith(".dbf") && !f.name.toLowerCase().endsWith(".prj")
    ) || fileList[0];

    setIsUploading(true);
    setUploadFileName(mainFile.name);
    setUploadStep("reading");

    try {
      const formData = new FormData();
      fileList.forEach((f) => formData.append("files", f));

      const uploadRes = await fetch("/api/upload-geo", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({ error: uploadRes.statusText }));
        throw new Error(err.error || `Erreur serveur: ${uploadRes.status}`);
      }

      const parsed = await uploadRes.json() as {
        geoJson: string;
        featureCount: number;
        format: string;
        crs: string;
        microstationReport?: { warnings: string[]; nbParcelles: number; nbSansNumero: number };
      };

      if (parsed.microstationReport?.warnings?.length) {
        toast.warning("Vérifications Microstation", {
          description: parsed.microstationReport.warnings.slice(0, 3).join(" · "),
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
        const err = await analysisRes.json().catch(() => ({ error: analysisRes.statusText }));
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
  }, [isUploading, router]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) handleFiles(files);
    },
    [handleFiles]
  );

  return (
    <div className="min-h-screen bg-background text-foreground overflow-auto">
      <NavBar user={user} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{ backgroundImage: "linear-gradient(oklch(0.65 0.18 220) 1px, transparent 1px), linear-gradient(90deg, oklch(0.65 0.18 220) 1px, transparent 1px)", backgroundSize: "50px 50px" }}
        />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full pointer-events-none"
          style={{ background: "radial-gradient(ellipse, oklch(0.65 0.18 220 / 0.15), transparent 70%)" }} />

        <div className="relative max-w-7xl mx-auto px-6 pt-24 pb-20">
          <div className="text-center max-w-5xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/5 text-primary text-xs font-medium mb-8">
              <Activity className="w-3.5 h-3.5 animate-pulse" />
              Plateforme IA de Fiabilisation Cadastrale — Sénégal 2025
            </div>

            <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
              L&apos;Intelligence Géospatiale
              <br />
              <span className="text-primary">orientée fiabilisation des données cadastrales</span>
            </h1>

            <p className="text-xl text-muted-foreground mb-10 max-w-3xl mx-auto leading-relaxed">
              Détection automatique des erreurs topologiques, correction intelligente et rapport d&apos;expertise.
              Remplace la chaîne de traitement <strong className="text-foreground">Microstation en 5 minutes</strong>.
            </p>

            {stats.totalAnalyses > 0 && (
              <div className="flex items-center justify-center gap-6 mb-10 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Database className="w-4 h-4 text-primary" />
                  <span><strong className="text-foreground">{stats.totalAnalyses}</strong> analyses</span>
                </div>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="w-4 h-4 text-blue-400" />
                  <span><strong className="text-foreground">{(stats.totalParcelles ?? 0).toLocaleString()}</strong> parcelles traitées</span>
                </div>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  <span>Conformité moy. <strong className="text-green-400">{toNum(stats.avgConformity).toFixed(1)}%</strong></span>
                </div>
              </div>
            )}

            {/* Format chips */}
            <div className="flex flex-wrap justify-center gap-2 mb-10">
              {FORMATS.map((f) => (
                <span key={f} className="px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-mono border border-border">
                  {f}
                </span>
              ))}
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed rounded-2xl p-14 transition-all cursor-pointer group max-w-2xl mx-auto ${
                isDragging ? "border-primary bg-primary/5 scale-[1.01]" : "border-border hover:border-primary/50 hover:bg-secondary/20"
              }`}
              onClick={() => { if (!isUploading) document.getElementById("file-input")?.click(); }}
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
                          <p className="text-sm font-semibold text-green-400">Analyse terminée</p>
                          <p className="text-xs text-muted-foreground font-mono truncate max-w-52">{uploadFileName}</p>
                        </div>
                      </div>

                      {/* KPIs rapides */}
                      <div className="flex gap-4 text-center">
                        <div>
                          <p className="text-2xl font-bold text-primary">{analysisResult.totalFeatures.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">Parcelles</p>
                        </div>
                        <div className="w-px bg-border" />
                        <div>
                          <p className="text-2xl font-bold text-red-400">{analysisResult.errorCount}</p>
                          <p className="text-xs text-muted-foreground">Erreurs</p>
                        </div>
                        <div className="w-px bg-border" />
                        <div>
                          <p className={`text-2xl font-bold ${analysisResult.conformityScore >= 70 ? "text-green-400" : "text-orange-400"}`}>
                            {analysisResult.conformityScore.toFixed(0)}%
                          </p>
                          <p className="text-xs text-muted-foreground">Conformité</p>
                        </div>
                      </div>

                      {/* Boutons d'action */}
                      <div className="flex gap-3 flex-wrap justify-center w-full">
                        <Button
                          size="lg"
                          className="gap-2 flex-1 min-w-[160px] shadow-lg shadow-primary/20"
                          onClick={() => router.push(`/map/${analysisResult.id}`)}
                        >
                          <MapPin className="w-4 h-4" /> Voir sur la carte
                        </Button>
                        <Button
                          size="lg"
                          variant="outline"
                          className="gap-2 flex-1 min-w-[160px]"
                          onClick={() => router.push(`/map/${analysisResult.id}?tab=table`)}
                        >
                          <Database className="w-4 h-4" /> Voir les données
                        </Button>
                      </div>

                      <button
                        onClick={() => { setIsUploading(false); setUploadStep(null); setAnalysisResult(null); setUploadFileName(null); }}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Charger un autre fichier
                      </button>
                    </div>
                  ) : (
                    /* ── Progression ── */
                    <>
                      <div className="relative">
                        <div className="w-20 h-20 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                        <Brain className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                      </div>
                      {uploadFileName && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary border text-xs">
                          <FileText className="w-3.5 h-3.5 text-primary" />
                          <span className="font-mono truncate max-w-48">{uploadFileName}</span>
                        </div>
                      )}
                      <div className="text-sm text-primary font-medium">
                        {uploadStep === "reading" && "📂 Lecture du fichier..."}
                        {uploadStep === "analyzing" && "🔍 Analyse topologique en cours..."}
                        {uploadStep === "ai" && "🤖 Génération du rapport IA..."}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-5">
                  <div className={`w-20 h-20 rounded-2xl border-2 flex items-center justify-center transition-all ${isDragging ? "border-primary bg-primary/10 scale-110" : "border-border group-hover:border-primary/50"}`}>
                    <Upload className={`w-9 h-9 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`} />
                  </div>
                  <div className="text-center">
                    <p className="text-xl font-semibold mb-2">
                      {isDragging ? "Déposez vos fichiers ici" : "Glissez-déposez vos fichiers cadastraux"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      ou <span className="text-primary underline">parcourez vos fichiers</span> — SHP, GeoJSON, DGN, DXF, KML, CSV
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      ⚠️ Pour les Shapefiles : sélectionnez <strong>.shp + .dbf + .prj</strong> ensemble
                    </p>
                  </div>
                  <div className="flex items-center gap-6 text-xs text-muted-foreground border-t border-border pt-4 w-full justify-center">
                    <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> Analyse automatique</span>
                    <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> Rapport IA instantané</span>
                    <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> Carte interactive</span>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => router.push("/map")} className="gap-2 text-muted-foreground">
                <MapPin className="w-4 h-4" /> Ouvrir la carte <ChevronRight className="w-3.5 h-3.5" />
              </Button>
              <span className="text-border">|</span>
              <Button variant="ghost" size="sm" onClick={() => router.push("/history")} className="gap-2 text-muted-foreground">
                <History className="w-4 h-4" /> Historique <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Error types */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold mb-3">6 Types d&apos;Anomalies Détectées</h2>
          <p className="text-muted-foreground max-w-xl mx-auto">Chaque type d&apos;erreur est identifié, localisé et expliqué par l&apos;agent IA</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {ERROR_TYPES.map((err) => (
            <div key={err.label} className="rounded-xl border border-border bg-card p-5 text-center hover:border-primary/30 transition-all group">
              <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center group-hover:scale-110 transition-transform"
                style={{ background: `${err.color}20`, border: `1px solid ${err.color}40` }}>
                <div className="w-3 h-3 rounded-full" style={{ background: err.color }} />
              </div>
              <p className="text-xs font-semibold mb-1">{err.label}</p>
              <p className="text-[10px] text-muted-foreground font-mono">{err.sublabel}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Workflow */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-3">Comment ça fonctionne ?</h2>
          <p className="text-muted-foreground">4 étapes automatisées pour fiabiliser vos données cadastrales</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {WORKFLOW_STEPS.map((step) => (
            <div key={step.step} className="rounded-xl border border-border bg-card p-6 hover:border-primary/30 transition-all hover:shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-3xl font-bold text-primary/20 font-mono">{step.step}</span>
                <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <step.icon className="w-4 h-4 text-primary" />
                </div>
              </div>
              <h3 className="font-semibold mb-2 text-sm">{step.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-3">Fonctionnalités Avancées</h2>
          <p className="text-muted-foreground max-w-xl mx-auto">Une suite complète d&apos;outils IA pour remplacer votre chaîne de traitement Microstation</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feat) => (
            <div key={feat.title} className="rounded-xl border border-border bg-card p-6 hover:border-primary/30 transition-all hover:shadow-xl group">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"
                style={{ background: `${feat.color}15`, border: `1px solid ${feat.color}30` }}>
                <feat.icon className="w-6 h-6" style={{ color: feat.color }} />
              </div>
              <h3 className="font-semibold mb-2">{feat.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{feat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Stats comparison */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="p-8 border-b border-border text-center">
            <h2 className="text-2xl font-bold mb-2">GEO-AINO SUPREME™ vs Microstation</h2>
            <p className="text-muted-foreground text-sm">Comparaison sur un cadastre de 2962 parcelles</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-0">
            {[
              { value: "5 min", label: "Temps de traitement", sub: "vs 2-3 jours", icon: Zap, color: "text-primary" },
              { value: "99%", label: "Automatisation", sub: "vs 0% manuel", icon: Brain, color: "text-blue-400" },
              { value: "6+", label: "Types d'erreurs", sub: "détectés automatiquement", icon: AlertTriangle, color: "text-red-400" },
              { value: "100%", label: "Traçabilité", sub: "historique complet", icon: Lock, color: "text-green-400" },
            ].map((stat, i) => (
              <div key={stat.label} className={`p-8 text-center ${i < 3 ? "border-r border-border" : ""}`}>
                <stat.icon className={`w-7 h-7 ${stat.color} mx-auto mb-3`} />
                <div className={`text-4xl font-bold ${stat.color} mb-1`}>{stat.value}</div>
                <div className="text-sm font-medium mb-1">{stat.label}</div>
                <div className="text-xs text-muted-foreground">{stat.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-12 text-center relative overflow-hidden">
          <TrendingUp className="w-12 h-12 text-primary mx-auto mb-4" />
          <h2 className="text-3xl font-bold mb-3">Prêt à fiabiliser vos données cadastrales ?</h2>
          <p className="text-muted-foreground mb-8 max-w-lg mx-auto">
            Chargez votre fichier SHP, GeoJSON ou DGN et obtenez un rapport d&apos;expert en quelques minutes
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Button size="lg" onClick={() => document.getElementById("file-input")?.click()} className="gap-2 shadow-xl shadow-primary/20 px-8">
              <Upload className="w-5 h-5" /> Charger un fichier
            </Button>
            <Button size="lg" variant="outline" onClick={() => router.push("/map")} className="gap-2 px-8">
              <MapPin className="w-5 h-5" /> Explorer la carte <ArrowRight className="w-4 h-4" />
            </Button>
            <Button size="lg" variant="ghost" onClick={() => router.push("/dashboard")} className="gap-2 px-8 text-muted-foreground">
              <BarChart2 className="w-5 h-5" /> Dashboard
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <span className="font-semibold text-foreground">GEO-AINO SUPREME™</span>
            <span>v5.0 — Plateforme IA de Fiabilisation Cadastrale</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="hover:text-foreground transition-colors">Dashboard</a>
            <a href="/history" className="hover:text-foreground transition-colors">Historique</a>
            <a href="/reports" className="hover:text-foreground transition-colors">Rapports</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
