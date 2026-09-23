import Link from "next/link";
import { auth } from "@/lib/auth";
import { NavBar } from "@/components/NavBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BarChart2,
  Landmark,
  History,
  FileText,
  Users,
  LayoutDashboard,
  Shapes,
  Eye,
  ShieldCheck,
  Sparkles,
  GitBranch,
  Layers,
  Map as MapIcon,
  Building2,
  GitMerge,
  HelpCircle,
  RotateCcw,
} from "lucide-react";

export const metadata = { title: "Aide" };

interface Section {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
  description: string;
  points?: string[];
}

const GENERAL: Section[] = [
  {
    id: "dashboard",
    icon: BarChart2,
    label: "Tableau de bord",
    href: "/dashboard",
    description:
      "Vue d'ensemble de vos imports et analyses DXF/shapefile : indicateurs de conformité, liste des fichiers traités, accès rapide à chaque analyse (carte, corrections, rapport).",
  },
  {
    id: "history",
    icon: History,
    label: "Historique",
    href: "/history",
    description:
      "Journal de toutes les analyses passées. Permet de retrouver un import précédent et d'y revenir, y compris pour restaurer une action de correction déjà appliquée.",
  },
  {
    id: "reports",
    icon: FileText,
    label: "Rapports",
    href: "/reports",
    description:
      "Consultation et export des rapports générés pour chaque analyse — score de conformité, nombre d'erreurs détectées, détail par type d'erreur topologique.",
  },
  {
    id: "admin-users",
    icon: Users,
    label: "Utilisateurs",
    href: "/admin/utilisateurs",
    description:
      "Gestion des comptes et de leurs rôles (Administrateur / Utilisateur). Réservé aux administrateurs — les actions destructrices ou de masse (basculements en lot, suppressions) exigent ce rôle.",
  },
];

const CADASTRE: Section[] = [
  {
    id: "cadastre-dashboard",
    icon: LayoutDashboard,
    label: "Tableau de bord — Cadastre",
    href: "/cadastre/dashboard",
    description:
      "Vue d'ensemble du référentiel NICAD (Syscol 2013 → 2026) : volumes par statut, avancement de la migration, indicateurs propres au module Cadastre.",
  },
  {
    id: "sections",
    icon: Shapes,
    label: "Gestion des sections",
    href: "/cadastre/sections",
    description:
      "Construit et entretient les limites de section (table limite_section) à partir d'un import DXF ou shapefile. Détecte les chevauchements entre sections (y compris entre deux lots différents) et permet de les corriger (découpe, fusion, choix de numéro).",
    points: [
      "C'est le référentiel que consultent le basculement NICAD et la migration en masse pour confirmer qu'une section existe réellement en 2026.",
      "Signale aussi les débordements d'une section hors de sa commune/département/région déclarée.",
    ],
  },
  {
    id: "parcelles",
    icon: Eye,
    label: "Visualisation des parcelles",
    href: "/cadastre/parcelles",
    description:
      "Carte en lecture seule combinant plusieurs fichiers déjà importés — utile pour comparer visuellement plusieurs zones sans risquer de modifier quoi que ce soit. Aucune action de correction n'est disponible ici.",
  },
  {
    id: "verification",
    icon: ShieldCheck,
    label: "Vérification NICAD",
    href: "/cadastre/verification",
    description:
      "Contrôle qu'un NICAD saisi respecte le format attendu (16 caractères : Syscol × 8, Section × 3, Parcelle × 5) et existe bien dans le référentiel.",
  },
  {
    id: "generation",
    icon: Sparkles,
    label: "Génération NICAD",
    href: "/cadastre/generation",
    description:
      "Attribue un nouveau NICAD à une parcelle par numérotation séquentielle dans la section choisie — pour une parcelle qui n'en a pas encore.",
  },
  {
    id: "basculement",
    icon: GitBranch,
    label: "Basculement 2013 → 2026",
    href: "/cadastre/basculement",
    description:
      "Fait basculer UN NICAD à la fois de l'ancien référentiel (Syscol 2013) vers le nouveau (Syscol 2026). L'identification est automatique : à partir du seul NICAD saisi, l'outil retrouve la commune 2026 correspondante et vérifie, par recoupement spatial, si la section a changé de numéro.",
    points: [
      "Cas simple : la section n'a pas changé — le NICAD 2026 garde le même numéro de section et de parcelle.",
      "Cas complexe : la section a été redécoupée ou renumérotée — un nouveau numéro de parcelle est attribué séquentiellement.",
      "Toute différence (correspondance incertaine, section introuvable…) est signalée avant de proposer le basculement — jamais appliquée automatiquement.",
    ],
  },
  {
    id: "migration",
    icon: Layers,
    label: "Migration en masse",
    href: "/cadastre/migration",
    description:
      "La même logique que le Basculement, mais pour un lot entier de NICAD à la fois, à partir d'un shapefile. Chaque ligne est identifiée automatiquement (cas simple ou complexe) et présentée dans un tableau de prévisualisation avant tout basculement réel.",
    points: [
      "Aucune écriture en base tant que vous n'avez pas validé la sélection — vous pouvez filtrer par statut (sans réserve / avec réserve / invalides…) avant de confirmer.",
      "Un historique des lots déjà migrés est affiché en bas de page.",
      "Le rapport peut être exporté en shapefile (géométrie réelle des parcelles + résultat du basculement), pour vérification dans un SIG avant ou après l'opération.",
    ],
  },
  {
    id: "carte",
    icon: MapIcon,
    label: "Carte interactive",
    href: "/cadastre/carte",
    description:
      "Affiche les parcelles cadastrales par commune sur une carte. Cliquer sur une parcelle affiche son NICAD décomposé (Syscol, section, numéro).",
  },
  {
    id: "communes",
    icon: Building2,
    label: "Communes",
    href: "/cadastre/communes",
    description:
      "Référentiel des communes, dans les deux systèmes de codification (Syscol 2013 et Syscol 2026) — région, département, code.",
  },
  {
    id: "correspondances",
    icon: GitMerge,
    label: "Correspondances",
    href: "/cadastre/correspondances",
    description:
      "Met en correspondance chaque commune 2013 avec sa commune 2026 (fusion, scission, renommage, recodification de Syscol). C'est cette table que le Basculement et la Migration en masse consultent pour savoir vers quelle commune 2026 diriger un NICAD.",
  },
  {
    id: "cadastre-historique",
    icon: History,
    label: "Historique — Cadastre",
    href: "/cadastre/historique",
    description:
      "Journal des basculements NICAD effectués et des opérations cadastrales (migrations, corrections de sections) — distinct de l'Historique général, propre au module Cadastre.",
  },
];

function SectionCard({ section }: { section: Section }) {
  const Icon = section.icon;
  return (
    <Card id={section.id} className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <Link href={section.href} className="hover:underline">
            {section.label}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{section.description}</p>
        {section.points && (
          <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {section.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AidePage() {
  const session = await auth();

  return (
    <div className="min-h-screen flex flex-col">
      <NavBar user={session?.user ?? null} />
      <main className="flex-1 min-w-0 py-6 px-6">
        <div className="mx-auto max-w-4xl space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <HelpCircle className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Aide</h1>
                <p className="text-sm text-muted-foreground">
                  À quoi sert chaque section de GéoAino.
                </p>
              </div>
            </div>
            <Link href="/dashboard?tour=1">
              <Button variant="outline" className="gap-2">
                <RotateCcw className="h-4 w-4" />
                Revoir le tour guidé
              </Button>
            </Link>
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            {[...GENERAL, ...CADASTRE].map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="rounded-full border border-border px-3 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {s.label}
              </a>
            ))}
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Landmark className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Général
              </h2>
            </div>
            <div className="space-y-4">
              {GENERAL.map((s) => (
                <SectionCard key={s.id} section={s} />
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Landmark className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Cadastre
              </h2>
            </div>
            <div className="space-y-4">
              {CADASTRE.map((s) => (
                <SectionCard key={s.id} section={s} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
