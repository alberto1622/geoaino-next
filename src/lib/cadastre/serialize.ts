import { Prisma } from "@prisma/client";

/**
 * Convertit récursivement les valeurs non sérialisables par les Server Actions
 * (Prisma.Decimal → string) en types simples. Les `Date` sont conservées telles
 * quelles (sérialisables par React Server Components).
 */
export function plain<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString() as unknown as T;
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => plain(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = plain((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}
