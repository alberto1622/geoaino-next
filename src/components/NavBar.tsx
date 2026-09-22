"use client";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  BarChart2,
  History,
  FileText,
  // MapPin,
  LogOut,
  LogIn,
  Landmark,
  Users,
  Menu,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
} from "@/components/ui/sheet";
// import { ThemeToggle } from "@/components/ThemeToggle";
import { signOutAction } from "@/app/_actions/auth";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { OnboardingTour } from "@/components/OnboardingTour";

interface NavBarProps {
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

const NAV_LINKS = [
  { label: "Tableau de bord", href: "/dashboard", icon: BarChart2, tourId: "nav-dashboard" },
  { label: "Cadastre", href: "/cadastre/dashboard", icon: Landmark, tourId: "nav-cadastre" },
  { label: "Historique", href: "/history", icon: History, tourId: "nav-history" },
  { label: "Rapports", href: "/reports", icon: FileText, tourId: "nav-reports" },
];

export function NavBar({ user }: NavBarProps) {
  const pathname = usePathname();
  const [tourRun, setTourRun] = useState(false);
  const links =
    user?.role === "ADMIN"
      ? [
          ...NAV_LINKS,
          { label: "Utilisateurs", href: "/admin/utilisateurs", icon: Users, tourId: "nav-admin-users" },
        ]
      : NAV_LINKS;

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Navigation mobile : les liens sont masqués sous md, un drawer les remplace. */}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Ouvrir le menu de navigation"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" title="Navigation">
              <nav className="flex flex-col gap-1">
                {links.map(({ label, href, icon: Icon }) => (
                  <SheetClose asChild key={href}>
                    <Link
                      href={href}
                      aria-current={pathname === href ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all",
                        pathname === href
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
            </SheetContent>
          </Sheet>

          <Link
            href="/"
            className="flex items-center"
            aria-label="GEO-AINO SUPREME — accueil"
          >
            <Logo className="h-12 sm:h-13" priority />
          </Link>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ label, href, icon: Icon, tourId }) => (
            <Link
              key={href}
              href={href}
              data-tour={tourId}
              aria-current={pathname === href ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-all",
                pathname === href
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* <ThemeToggle />
          <Link href="/map">
            <Button size="sm" className="gap-2 shadow-lg shadow-primary/20">
              <MapPin className="w-4 h-4" />
              Carte
            </Button>
          </Link> */}
          {user && (
            <Button
              variant="ghost"
              size="icon"
              data-tour="nav-aide"
              title="Aide"
              aria-label="Revoir le guide d'accueil"
              onClick={() => setTourRun(true)}
            >
              <HelpCircle className="w-4 h-4" />
            </Button>
          )}
          {user ? (
            <form action={signOutAction}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                title="Se déconnecter"
              >
                <LogOut className="w-4 h-4" />
                {user.name || user.email}
              </Button>
            </form>
          ) : (
            <Link href="/login">
              <Button variant="ghost" size="sm" className="gap-2">
                <LogIn className="w-4 h-4" />
                Connexion
              </Button>
            </Link>
          )}
        </div>
      </div>
      {user && (
        <OnboardingTour role={user.role} run={tourRun} setRun={setTourRun} />
      )}
    </header>
  );
}
