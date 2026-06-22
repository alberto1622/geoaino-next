import { getDashboardStats } from "../_actions/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Hash,
  GitBranch,
  Building2,
  Layers,
  MapPinned,
  Activity,
} from "lucide-react";

export const dynamic = "force-dynamic";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${accent}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          {sub ? <p className="truncate text-[11px] text-muted-foreground/70">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function CadastreDashboardPage() {
  const stats = await getDashboardStats();
  const fmt = (n: number) => n.toLocaleString("fr-FR");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tableau de bord — Cadastre</h1>
        <p className="text-sm text-muted-foreground">
          Vue d&apos;ensemble du référentiel NICAD (Syscol 2013 → 2026).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="NICAD enregistrés"
          value={fmt(stats.nicads.total)}
          sub={`2013 : ${fmt(stats.nicads.version2013)} · 2026 : ${fmt(stats.nicads.version2026)}`}
          icon={Hash}
          accent="bg-blue-500/15 text-blue-500"
        />
        <StatCard
          label="NICAD basculés"
          value={fmt(stats.nicads.bascules)}
          sub={`Taux de basculement : ${stats.nicads.tauxBasculement}%`}
          icon={GitBranch}
          accent="bg-emerald-500/15 text-emerald-500"
        />
        <StatCard
          label="Communes"
          value={`${fmt(stats.communes.total2013)} / ${fmt(stats.communes.total2026)}`}
          sub="Syscol 2013 / 2026"
          icon={Building2}
          accent="bg-violet-500/15 text-violet-500"
        />
        <StatCard
          label="Parcelles cadastrales"
          value={fmt(stats.parcelles.total)}
          icon={MapPinned}
          accent="bg-amber-500/15 text-amber-500"
        />
        <StatCard
          label="Sections cadastrales"
          value={fmt(stats.parcelles.sections)}
          icon={Layers}
          accent="bg-cyan-500/15 text-cyan-500"
        />
        <StatCard
          label="Opérations journalisées"
          value={fmt(stats.operations.total)}
          sub={`Basculements historisés : ${fmt(stats.historique.total)}`}
          icon={Activity}
          accent="bg-rose-500/15 text-rose-500"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Opérations récentes</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.operations.recentes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune opération enregistrée pour le moment.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {stats.operations.recentes.map((op) => (
                <li key={op.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium capitalize">{op.typeOperation}</span>
                    <span className="ml-2 text-muted-foreground">{op.description}</span>
                  </div>
                  <span
                    className={
                      op.statut === "succes"
                        ? "shrink-0 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500"
                        : op.statut === "echec"
                          ? "shrink-0 rounded bg-rose-500/15 px-2 py-0.5 text-xs text-rose-500"
                          : "shrink-0 rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500"
                    }
                  >
                    {op.statut}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
