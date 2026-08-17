"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
} from "@/components/ui/sheet";
import {
  Menu,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
  GitBranch,
  Map as MapIcon,
  Eye,
  Building2,
  GitMerge,
  Layers,
  Shapes,
  Upload,
  Download,
  History,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COLLAPSE_STORAGE_KEY = "geoaino-cadastre-sidebar-collapsed";

export const CADASTRE_NAV = [
  {
    label: "Tableau de bord",
    href: "/cadastre/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "Gestion des sections",
    href: "/cadastre/sections",
    icon: Shapes,
    // badge: "DXF, shp",
  },
  {
    label: "Vérification NICAD",
    href: "/cadastre/verification",
    icon: ShieldCheck,
  },
  { label: "Génération NICAD", href: "/cadastre/generation", icon: Sparkles },
  {
    label: "Basculement 2013→2026",
    href: "/cadastre/basculement",
    icon: GitBranch,
  },
  {
    label: "Migration en masse",
    href: "/cadastre/migration",
    icon: Layers,
    badge: "Masse",
  },
  { label: "Carte interactive", href: "/cadastre/carte", icon: MapIcon },
  {
    label: "Visualisation des parcelles",
    href: "/cadastre/parcelles",
    icon: Eye,
  },
  { label: "Communes", href: "/cadastre/communes", icon: Building2 },
  {
    label: "Correspondances",
    href: "/cadastre/correspondances",
    icon: GitMerge,
  },
  { label: "Import", href: "/cadastre/import", icon: Upload },
  { label: "Export", href: "/cadastre/export", icon: Download },
  { label: "Historique", href: "/cadastre/historique", icon: History },
] as const;

export function CadastreSidebar() {
  const pathname = usePathname();
  // Fixed "expanded" on SSR — server and client first render match, no
  // hydration mismatch; the real preference is synced after mount (same
  // pattern as ThemeProvider).
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
  };

  return (
    <aside
      className={cn(
        "hidden lg:flex shrink-0 flex-col border-r border-border/50 bg-card/30 p-3 transition-[width] duration-200",
        collapsed ? "w-14" : "w-64",
      )}
    >
      <div className="flex items-center gap-2 px-1 py-4">
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Module
            </span>
            <h2 className="truncate text-lg font-bold tracking-tight">
              Cadastre · NICAD
            </h2>
          </div>
        )}
        <button
          onClick={toggle}
          aria-label={
            collapsed
              ? "Déplier le menu du module Cadastre"
              : "Replier le menu du module Cadastre"
          }
          title={collapsed ? "Déplier le menu" : "Replier le menu"}
          className={cn(
            "shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            collapsed && "mx-auto",
          )}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </button>
      </div>
      <nav className="flex flex-col gap-1">
        {CADASTRE_NAV.map(({ label, href, icon: Icon, ...rest }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const badge = (rest as { badge?: string }).badge;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all",
                collapsed && "justify-center px-2",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && (
                <>
                  <span className="truncate">{label}</span>
                  {badge ? (
                    <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary">
                      {badge}
                    </span>
                  ) : null}
                </>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * Navigation mobile du module Cadastre : la sidebar est masquée sous 1024 px,
 * ce drawer donne accès aux mêmes entrées (sinon le module est inutilisable
 * sur mobile/tablette).
 */
export function CadastreMobileNav() {
  const pathname = usePathname();
  const current = CADASTRE_NAV.find(
    ({ href }) => pathname === href || pathname.startsWith(href + "/"),
  );

  return (
    <div className="flex items-center gap-3 border-b border-border/50 bg-card/30 px-4 py-2 lg:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            aria-label="Ouvrir le menu du module Cadastre"
          >
            <Menu className="h-4 w-4" />
            Menu
          </Button>
        </SheetTrigger>
        <SheetContent side="left" title="Cadastre · NICAD">
          <nav className="flex flex-col gap-1">
            {CADASTRE_NAV.map(({ label, href, icon: Icon, ...rest }) => {
              const active =
                pathname === href || pathname.startsWith(href + "/");
              const badge = (rest as { badge?: string }).badge;
              return (
                <SheetClose asChild key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all",
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
                </SheetClose>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
      <span className="truncate text-sm font-medium">
        {current?.label ?? "Cadastre · NICAD"}
      </span>
    </div>
  );
}
