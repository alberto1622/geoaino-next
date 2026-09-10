"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  MapPin,
  Brain,
  Shield,
  FileText,
  Activity,
  Layers,
  CheckCircle,
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
import { Logo } from "@/components/Logo";
import DxfPipelineSection from "@/components/home/DxfPipelineSection";
import NewAnalysisPanel, {
  type NewAnalysisPanelHandle,
} from "@/components/NewAnalysisPanel";
import { cn, toNum } from "@/lib/utils";

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

// Alignées sur les tokens sémantiques du design system (globals.css) et sur
// les identifiants réels du moteur de détection (cf. SETUP.md « Types
// d'erreurs détectées ») — même hiérarchie de sévérité que sur la carte.
const ERROR_TYPES = [
  { label: "Chevauchements", sublabel: "OVERLAP", severity: "crit" },
  { label: "Espaces vides", sublabel: "GAP", severity: "warn" },
  { label: "Résidus", sublabel: "SLIVER", severity: "warn" },
  { label: "Doublons NICAD", sublabel: "DUPLICATE", severity: "crit" },
  { label: "Géom. invalides", sublabel: "INVALID_GEOM", severity: "crit" },
  {
    label: "Croisements limites",
    sublabel: "BOUNDARY_CROSS",
    severity: "info",
  },
] as const satisfies ReadonlyArray<{
  label: string;
  sublabel: string;
  severity: "crit" | "warn" | "info";
}>;

const SEVERITY_STYLES: Record<
  "crit" | "warn" | "info",
  { border: string; badge: string; dot: string }
> = {
  crit: {
    border: "hover:border-crit/40",
    badge: "border-crit/30 bg-crit/10",
    dot: "bg-crit",
  },
  warn: {
    border: "hover:border-warn/40",
    badge: "border-warn/30 bg-warn/10",
    dot: "bg-warn",
  },
  info: {
    border: "hover:border-info/40",
    badge: "border-info/30 bg-info/10",
    dot: "bg-info",
  },
};

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  stats: {
    totalAnalyses: number;
    totalParcelles: number;
    avgConformity: number;
  };
}

export default function HomeClient({ user, stats }: Props) {
  const router = useRouter();
  const panelRef = useRef<NewAnalysisPanelHandle>(null);
  return (
    <div className="min-h-screen bg-background text-foreground overflow-auto">
      <NavBar user={user} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Quadrillage + halo à la teinte de marque (--primary), plutôt qu'un
            bleu arbitraire hors palette — réactif au thème clair/sombre. */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(var(--primary) 1px, transparent 1px), linear-gradient(90deg, var(--primary) 1px, transparent 1px)",
            backgroundSize: "50px 50px",
          }}
        />
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-425 h-100 rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse, color-mix(in oklab, var(--primary) 15%, transparent), transparent 70%)",
          }}
        />

        <div className="relative mx-auto px-6 pt-8 pb-6">
          <div className="text-center max-w-6xl mx-auto">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-3.5 py-1.5 text-primary">
              <Activity className="w-3.5 h-3.5" />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em]">
                Fiabilisation des données cadastrales et Foncières · Sénégal
              </span>
            </div>

            <h1 className="mt-5 text-4xl md:text-5xl font-bold tracking-tight leading-[1.08]">
              Fiabiliser les données cadastrales et Foncières
            </h1>
            <p className="mt-2 text-xl md:text-2xl font-semibold text-primary tracking-tight">
              Détection, correction et traçabilité
            </p>

            <p className="mx-auto mt-5 mb-10 max-w-2xl text-base md:text-lg leading-relaxed text-muted-foreground">
              Détection des erreurs topologiques, corrections proposées et
              rapports d&apos;analyse sur vos fichiers SHP, GeoJSON, DGN et DXF.
            </p>

            {/* Workflow — pipeline DXF réel (lecture → mappage → polygonisation → jointure) */}
            <div className="mb-6 flex items-center justify-center gap-3">
              <span className="h-px w-8 bg-border" aria-hidden="true" />
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Le pipeline, étape par étape
              </span>
              <span className="h-px w-8 bg-border" aria-hidden="true" />
            </div>
            <DxfPipelineSection />

            {stats.totalAnalyses > 0 && (
              <>
                <p className="mt-10 mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                  En chiffres
                </p>
                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 mb-10 text-lg">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Database className="w-4 h-4 text-primary" />
                    <span>
                      <strong className="font-serif tabular-nums text-foreground">
                        {stats.totalAnalyses}
                      </strong>{" "}
                      analyses
                    </span>
                  </div>
                  <div className="w-px h-4 bg-border" />
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="w-4 h-4 text-info" />
                    <span>
                      <strong className="font-serif tabular-nums text-foreground">
                        {(stats.totalParcelles ?? 0).toLocaleString()}
                      </strong>{" "}
                      parcelles traitées
                    </span>
                  </div>
                  <div className="w-px h-4 bg-border" />
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <CheckCircle className="w-4 h-4 text-good" />
                    <span>
                      Conformité moy.{" "}
                      <strong className="font-serif tabular-nums text-good">
                        {toNum(stats.avgConformity).toFixed(1)}%
                      </strong>
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Format chips */}
            <div className="flex flex-wrap justify-center gap-2 mb-10">
              {FORMATS.map((f) => (
                <span
                  key={f}
                  className="px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground text-xs font-mono uppercase tracking-[0.06em] border border-border"
                >
                  {f}
                </span>
              ))}
            </div>

            {/* Flux « nouvelle analyse » (glisser-déposer + mappage + progression). */}
            <NewAnalysisPanel ref={panelRef} />

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
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary mb-3">
            Contrôle topologique
          </p>
          <h2 className="text-3xl font-bold mb-3">
            6 types d&apos;anomalies détectées
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Chaque type d&apos;erreur est identifié, localisé et expliqué par
            l&apos;agent IA
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {ERROR_TYPES.map((err) => {
            const sv = SEVERITY_STYLES[err.severity];
            return (
              <div
                key={err.label}
                className={cn(
                  "rounded-lg border border-border bg-card p-5 text-center transition-all group",
                  sv.border,
                )}
              >
                <div
                  className={cn(
                    "w-10 h-10 rounded-md border mx-auto mb-3 flex items-center justify-center group-hover:scale-110 transition-transform",
                    sv.badge,
                  )}
                >
                  <div className={cn("w-3 h-3 rounded-full", sv.dot)} />
                </div>
                <p className="text-xs font-semibold mb-1">{err.label}</p>
                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-[0.06em]">
                  {err.sublabel}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-primary mb-3">
            La plateforme
          </p>
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
              className="rounded-lg border border-border bg-card p-6 hover:border-primary/30 transition-all hover:shadow-panel group"
            >
              <div
                className="w-12 h-12 rounded-md flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"
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
        <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-12 text-center relative overflow-hidden">
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
              onClick={() => panelRef.current?.openFilePicker()}
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
          <div className="flex items-center gap-3">
            <Logo className="h-10" />
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
    </div>
  );
}
