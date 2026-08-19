"use client";

/**
 * JobProgressSteps — affichage unifié de la progression d'un job d'import
 * asynchrone (`ImportJob` / `run-job.ts` / `run-shapefile-job.ts`), sous forme
 * d'étapes numérotées (lues → construites → …) au lieu d'un simple libellé de
 * phase brute + barre de pourcentage. Remplace trois implémentations
 * dupliquées et incohérentes entre elles (`/cadastre/import`, `HomeClient`,
 * `SectionsClient` — cette dernière affichait même la clé de phase brute,
 * ex. « Phase : nicad », jamais traduite).
 *
 * Chaque appelant connaît son propre pipeline (DXF « parcelles » a 4 phases,
 * « sections » en a 3, shapefile cad-* en a 2, cf. `run-job.ts` /
 * `run-shapefile-job.ts`) : il passe la liste ORDONNÉE des étapes réellement
 * traversées par SON job. L'étape courante est retrouvée en comparant
 * `phase` (valeur brute renvoyée par l'API) à `steps[i].key`.
 */
import { Check, Loader2 } from "lucide-react";

export interface JobProgressStep {
  key: string;
  label: string;
}

export type JobProgressStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface JobProgressStepsProps {
  steps: JobProgressStep[];
  phase: string | null;
  status: JobProgressStatus;
  progress: number;
  /** Réduit tailles/espacements pour les emplacements étroits (ex. panneau latéral). */
  compact?: boolean;
}

export function JobProgressSteps({ steps, phase, status, progress, compact = false }: JobProgressStepsProps) {
  const allDone = status === "completed" || phase === "done";
  const rawIndex = steps.findIndex((s) => s.key === phase);
  // Phase pas encore reçue (job tout juste créé) ⇒ première étape considérée active.
  const currentIndex = allDone ? steps.length : rawIndex < 0 ? 0 : rawIndex;
  const failed = status === "failed";
  const activeStep = steps[currentIndex];

  const circleSize = compact ? "h-5 w-5" : "h-7 w-7";
  const iconSize = compact ? "h-3 w-3" : "h-4 w-4";

  return (
    <div className={compact ? "space-y-1.5" : "space-y-3"}>
      <div className="flex items-start">
        {steps.map((step, i) => {
          const isDone = i < currentIndex;
          const isActive = i === currentIndex && !allDone;
          const isError = isActive && failed;
          const isLast = i === steps.length - 1;
          return (
            <div key={step.key} className={isLast ? "flex flex-none items-center" : "flex flex-1 items-center"}>
              <div className="flex flex-col items-center gap-1">
                <div
                  className={[
                    circleSize,
                    "flex items-center justify-center rounded-full border-2 transition-colors duration-300",
                    isError
                      ? "border-rose-500 bg-rose-500/10 text-rose-500"
                      : isDone
                        ? "border-primary bg-primary text-primary-foreground"
                        : isActive
                          ? "border-primary text-primary"
                          : "border-border text-muted-foreground",
                  ].join(" ")}
                  title={step.label}
                >
                  {isError ? (
                    <span className={compact ? "text-[10px] font-bold" : "text-xs font-bold"}>!</span>
                  ) : isDone ? (
                    <Check className={iconSize} />
                  ) : isActive ? (
                    <Loader2 className={`${iconSize} animate-spin`} />
                  ) : (
                    <span className={compact ? "text-[9px]" : "text-[11px]"}>{i + 1}</span>
                  )}
                </div>
                {!compact && (
                  <span
                    className={[
                      "max-w-24 text-center text-[10px] leading-tight",
                      isActive ? "font-medium text-primary" : isDone ? "text-foreground/80" : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {step.label}
                  </span>
                )}
              </div>
              {!isLast && (
                <div
                  className={[
                    "mx-1 h-0.5 flex-1 self-start rounded-full transition-colors duration-300",
                    compact ? "mt-2.5" : "mt-3.5",
                    i < currentIndex ? "bg-primary" : "bg-border",
                  ].join(" ")}
                />
              )}
            </div>
          );
        })}
      </div>

      {compact && !allDone && (
        <div className={`text-center text-[11px] font-medium ${failed ? "text-rose-500" : "text-primary"}`}>
          {activeStep?.label ?? "Démarrage…"}
        </div>
      )}

      <div className="space-y-1">
        <div className={`${compact ? "h-1.5" : "h-2"} w-full overflow-hidden rounded-full bg-secondary`}>
          <div
            className={`h-full rounded-full transition-all duration-500 ${failed ? "bg-rose-500" : "bg-primary"}`}
            style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }}
          />
        </div>
        <div className="text-center text-[11px] text-muted-foreground">{progress}%</div>
      </div>
    </div>
  );
}
