/**
 * rate-limit.ts — limitation de débit en mémoire (fenêtre fixe).
 *
 * Suffisant pour le déploiement actuel (un seul processus Node : Docker
 * `next start` ou bureau autonome). Derrière plusieurs instances, les compteurs
 * ne seraient pas partagés : il faudrait alors un stockage commun (Redis, table
 * Postgres).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function purgeExpired(now: number): void {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Secondes avant la réouverture de la fenêtre (utile pour `Retry-After`). */
  retryAfterSec: number;
}

/**
 * Comptabilise un essai pour `key` et indique s'il reste sous `limit` essais
 * par fenêtre de `windowMs`.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) purgeExpired(now);

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return {
    allowed: b.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

/** Remet un compteur à zéro (ex. après une connexion réussie). */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** IP client la plus probable (premier saut de `x-forwarded-for`, sinon `x-real-ip`). */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}
