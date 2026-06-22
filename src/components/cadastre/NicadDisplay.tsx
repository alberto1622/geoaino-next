import { cn } from "@/lib/utils";

/**
 * Affiche un NICAD décomposé en ses trois parties : Syscol (8) · Section (3) · Parcelle (5).
 */
export function NicadDisplay({
  nicad,
  className,
  size = "md",
}: {
  nicad: string | null | undefined;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  if (!nicad || nicad.length !== 16) {
    return <span className={cn("font-mono text-muted-foreground", className)}>{nicad || "—"}</span>;
  }
  const syscol = nicad.substring(0, 8);
  const section = nicad.substring(8, 11);
  const parcelle = nicad.substring(11, 16);
  const text = size === "lg" ? "text-base" : size === "sm" ? "text-xs" : "text-sm";

  return (
    <span className={cn("inline-flex items-center gap-1 font-mono", text, className)}>
      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-blue-500" title="Syscol (commune)">
        {syscol}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-500" title="Section">
        {section}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-500" title="Parcelle">
        {parcelle}
      </span>
    </span>
  );
}
