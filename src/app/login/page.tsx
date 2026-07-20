"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Globe, LogIn, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTitle } from "@/components/PageTitle";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (result?.error) {
        toast.error("Identifiants incorrects");
      } else {
        toast.success("Connexion réussie");
        router.push("/dashboard");
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <PageTitle title="Connexion" />
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-xl shadow-primary/30 mx-auto mb-4">
            <Globe className="w-7 h-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold">GéoAino</h1>
          <p className="text-sm text-muted-foreground mt-1">Fiabilisation des données cadastrales</p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-xl">
          <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
            <LogIn className="w-5 h-5 text-primary" /> Connexion
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Email
              </label>
              <Input
                id="login-email"
                type="email"
                placeholder="agent@geoaino.sn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Mot de passe
              </label>
              <Input
                id="login-password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full gap-2" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {loading ? "Connexion..." : "Se connecter"}
            </Button>
          </form>

          <p className="text-xs text-muted-foreground text-center mt-4">
            L&apos;accès est réservé aux agents habilités. Contactez un administrateur pour obtenir un
            compte.
          </p>
        </div>
      </div>
    </div>
  );
}
