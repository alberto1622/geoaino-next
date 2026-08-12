"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Globe,
  BarChart2,
  History,
  FileText,
  MapPin,
  LogOut,
  LogIn,
  Landmark,
  Users,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
} from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { signOutAction } from "@/app/_actions/auth";
import { cn } from "@/lib/utils";

interface NavBarProps {
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

const NAV_LINKS = [
  { label: "Tableau de bord", href: "/dashboard", icon: BarChart2 },
  { label: "Cadastre", href: "/cadastre/dashboard", icon: Landmark },
  { label: "Historique", href: "/history", icon: History },
  { label: "Rapports", href: "/reports", icon: FileText },
];

export function NavBar({ user }: NavBarProps) {
  const pathname = usePathname();
  const links =
    user?.role === "ADMIN"
      ? [
          ...NAV_LINKS,
          { label: "Utilisateurs", href: "/admin/utilisateurs", icon: Users },
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

          <Link href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30">
              <Globe className="w-5 h-5 text-primary-foreground" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-lg tracking-tight">GéoAino</span>
              <span className="hidden sm:inline text-xs text-muted-foreground">
                Fiabilisation cadastrale
              </span>
            </div>
          </Link>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
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
    </header>
  );
}
