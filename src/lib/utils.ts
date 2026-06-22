import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toNum(value: unknown): number {
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

export function formatArea(m2: number): string {
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`;
  return `${m2.toFixed(2)} m²`;
}

export function formatScore(score: unknown): string {
  return `${toNum(score).toFixed(1)}%`;
}

export function severityColor(severity: string): string {
  switch (severity?.toLowerCase()) {
    case "critical": return "text-red-500";
    case "high": return "text-orange-500";
    case "medium": return "text-yellow-500";
    case "low": return "text-blue-500";
    default: return "text-muted-foreground";
  }
}

export function errorTypeColor(type: string): string {
  switch (type?.toLowerCase()) {
    case "overlap": return "#ef4444";
    case "gap": return "#f59e0b";
    case "sliver": return "#a855f7";
    case "duplicate": return "#3b82f6";
    case "invalid_geom": return "#ec4899";
    case "boundary_cross": return "#06b6d4";
    case "missing_nicad": return "#22c55e";
    case "self_intersect": return "#f97316";
    default: return "#6b7280";
  }
}
