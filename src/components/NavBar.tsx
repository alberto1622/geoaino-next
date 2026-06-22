"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Globe, BarChart2, History, FileText, MapPin, LogOut, LogIn, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

interface NavBarProps {
  user?: { name?: string | null; email?: string | null } | null;
}

const NAV_LINKS = [
  { label: "Dashboard", href: "/dashboard", icon: BarChart2 },
  { label: "Cadastre", href: "/cadastre/dashboard", icon: Landmark },
  { label: "Historique", href: "/history", icon: History },
  { label: "Rapports", href: "/reports", icon: FileText },
];

export function NavBar({ user }: NavBarProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30">
            <Globe className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="font-bold text-lg tracking-tight">GEO-AINO</span>
            <span className="text-primary font-bold text-lg"> SUPREME™</span>
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono border border-primary/20">
              v5.0
            </span>
          </div>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-all",
                pathname === href
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/map">
            <Button size="sm" className="gap-2 shadow-lg shadow-primary/20">
              <MapPin className="w-4 h-4" />
              Carte
            </Button>
          </Link>
          {user ? (
            <form action="/api/auth/signout" method="POST">
              <Button variant="ghost" size="sm" className="gap-2">
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
