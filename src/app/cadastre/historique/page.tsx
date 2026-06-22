import { historiqueRecent } from "../_actions/nicad";
import { getRecentOperationsList } from "../_actions/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NicadDisplay } from "@/components/cadastre/NicadDisplay";

export const dynamic = "force-dynamic";

export default async function HistoriquePage() {
  const [historique, operations] = await Promise.all([
    historiqueRecent({ limit: 50 }),
    getRecentOperationsList({ limit: 50 }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Historique</h1>
        <p className="text-sm text-muted-foreground">Basculements NICAD et journal des opérations.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basculements ({historique.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {historique.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun basculement enregistré.</p>
          ) : (
            <div className="space-y-2">
              {historique.map((h) => (
                <div
                  key={h.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 p-3 text-sm"
                >
                  <NicadDisplay nicad={h.nicadAncien} size="sm" />
                  <span className="text-muted-foreground">→</span>
                  <NicadDisplay nicad={h.nicadNouveau} size="sm" />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {h.communeAncienne ?? "—"} → {h.communeNouvelle ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Journal des opérations ({operations.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {operations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune opération.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {operations.map((op) => (
                <li key={op.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium capitalize">{op.typeOperation}</span>
                    <span className="ml-2 text-muted-foreground">{op.description}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {op.nbSucces}✓ / {op.nbEchecs}✗
                    </span>
                    <span
                      className={
                        op.statut === "succes"
                          ? "rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-500"
                          : op.statut === "echec"
                            ? "rounded bg-rose-500/15 px-2 py-0.5 text-rose-500"
                            : "rounded bg-amber-500/15 px-2 py-0.5 text-amber-500"
                      }
                    >
                      {op.statut}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
