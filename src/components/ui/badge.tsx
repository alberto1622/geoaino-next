import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Design system « Graticule » : pastille = mono, capitales, interlettrage,
// couleur sémantique. La sévérité se lit par la teinte ET par le libellé
// (jamais la couleur seule). Les noms critical/high/medium/low sont conservés
// pour la compat des usages existants.
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-border-strong bg-surface-3 text-muted-foreground",
        outline: "border-border text-foreground",
        neutral: "border-border-strong bg-surface-3 text-muted-foreground",
        success: "border-good/30 bg-good/10 text-good",
        warn: "border-warn/30 bg-warn/10 text-warn",
        info: "border-info/30 bg-info/10 text-info",
        destructive: "border-crit/30 bg-crit/10 text-crit",
        critical: "border-crit/30 bg-crit/10 text-crit",
        high: "border-crit/30 bg-crit/10 text-crit",
        medium: "border-warn/30 bg-warn/10 text-warn",
        low: "border-info/30 bg-info/10 text-info",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
