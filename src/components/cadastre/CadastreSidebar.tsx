"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
  GitBranch,
  Map as MapIcon,
  Building2,
  GitMerge,
  Layers,
  Shapes,
  Upload,
  Download,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const CADASTRE_NAV = [
  { label: "Tableau de bord", href: "/cadastre/dashboard", icon: LayoutDashboard },
  { label: "Vérification NICAD", href: "/cadastre/verification", icon: ShieldCheck },
  { label: "Génération NICAD", href: "/cadastre/generation", icon: Sparkles },
  { label: "Basculement 2013→2026", href: "/cadastre/basculement", icon: GitBranch },
  { label: "Migration en masse", href: "/cadastre/migration", icon: Layers, badge: "Masse" },
  { label: "Carte interactive", href: "/cadastre/carte", icon: MapIcon },
  { label: "Limites de section", href: "/cadastre/sections", icon: Shapes, badge: "DXF" },
  { label: "Communes", href: "/cadastre/communes", icon: Building2 },
  { label: "Correspondances", href: "/cadastre/correspondances", icon: GitMerge },
  { label: "Import", href: "/cadastre/import", icon: Upload },
  { label: "Export", href: "/cadastre/export", icon: Download },
  { label: "Historique", href: "/cadastre/historique", icon: History },
] as const;

export function CadastreSidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-border/50 bg-card/30 p-3">
      <div className="px-3 py-4">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Module
        </span>
        <h2 className="text-lg font-bold tracking-tight">Cadastre · NICAD</h2>
      </div>
      <nav className="flex flex-col gap-1">
        {CADASTRE_NAV.map(({ label, href, icon: Icon, ...rest }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const badge = (rest as { badge?: string }).badge;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
              {badge ? (
                <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
