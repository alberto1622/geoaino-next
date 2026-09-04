import Link from "next/link";
import { MapPinOff, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="flex justify-center mb-6">
          <Logo className="h-7" />
        </div>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MapPinOff className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-bold tracking-tight">Page introuvable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          La page demandée n&apos;existe pas ou a été déplacée.
        </p>
        <div className="mt-6">
          <Link href="/">
            <Button className="gap-2">
              <Home className="h-4 w-4" />
              Retour à l&apos;accueil
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
