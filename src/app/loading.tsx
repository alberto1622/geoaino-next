import { Loader2 } from "lucide-react";
import { Logo } from "@/components/Logo";

export default function Loading() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-6">
      <Logo className="h-20" priority />
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Chargement…</span>
      </div>
    </div>
  );
}
