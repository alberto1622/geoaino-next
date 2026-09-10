import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

interface LogoLoaderProps {
  /** Classe du conteneur externe (centrage, marges…). */
  className?: string;
  /** Classe de hauteur du logo (ex. "h-32"). */
  logoClassName?: string;
  /** Texte sous le logo. `null` pour n'afficher que le logo animé. */
  label?: string | null;
}

// Dimensions intrinsèques du logo (cf. Logo.tsx) — le viewBox du SVG les
// reprend pour que l'overlay recouvre EXACTEMENT la boîte du logo et suive sa
// taille sans déformer le point qui circule.
const W = 793;
const H = 315;
// Retrait du cadre par rapport au bord de la boîte (unités viewBox) et rayon
// des coins arrondis.
const INSET = 16;
const RADIUS = 30;

// Cadre à coins arrondis parcouru par le point. Défini une seule fois : sert à
// la fois d'attribut `d` (piste + comète) et de `offset-path` (point) via le
// bloc <style> ci-dessous — les deux DOIVENT rester identiques.
const TRACK_D = [
  `M ${INSET + RADIUS},${INSET}`,
  `L ${W - INSET - RADIUS},${INSET}`,
  `A ${RADIUS} ${RADIUS} 0 0 1 ${W - INSET},${INSET + RADIUS}`,
  `L ${W - INSET},${H - INSET - RADIUS}`,
  `A ${RADIUS} ${RADIUS} 0 0 1 ${W - INSET - RADIUS},${H - INSET}`,
  `L ${INSET + RADIUS},${H - INSET}`,
  `A ${RADIUS} ${RADIUS} 0 0 1 ${INSET},${H - INSET - RADIUS}`,
  `L ${INSET},${INSET + RADIUS}`,
  `A ${RADIUS} ${RADIUS} 0 0 1 ${INSET + RADIUS},${INSET}`,
  "Z",
].join(" ");

const LAP_DURATION = "1.7s";

const CSS = `
.geoaino-ll { color: var(--primary); }

/* Comète : arc court qui circule le long du cadre (traînée du point). */
.geoaino-ll-comet {
  stroke-dasharray: 70 930;
  animation: geoaino-ll-dash ${LAP_DURATION} linear infinite;
  filter: drop-shadow(0 0 4px currentColor);
}
@keyframes geoaino-ll-dash {
  to { stroke-dashoffset: -1000; }
}

/* Point net + halo, orbitant sur le même cadre. */
.geoaino-ll-dot {
  offset-path: path("${TRACK_D}");
  offset-rotate: 0deg;
  animation: geoaino-ll-orbit ${LAP_DURATION} linear infinite;
}
.geoaino-ll-dot--core { filter: drop-shadow(0 0 6px currentColor) drop-shadow(0 0 16px currentColor); }
@keyframes geoaino-ll-orbit {
  to { offset-distance: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .geoaino-ll-comet,
  .geoaino-ll-dot { animation: none; }
  .geoaino-ll-dot { offset-distance: 0%; }
}
`;

/**
 * Écran de chargement de page : le logo GEO-AINO, avec un point lumineux qui
 * circule sur les bords d'un cadre épousant sa boîte (piste discrète + comète +
 * point à halo). 100 % CSS — respecte `prefers-reduced-motion`.
 */
export function LogoLoader({
  className,
  logoClassName = "h-28",
  label = "Chargement…",
}: LogoLoaderProps) {
  return (
    <div
      className={cn(
        "geoaino-ll text-primary flex flex-col items-center gap-6",
        className,
      )}
    >
      <style>{CSS}</style>
      {/* Boîte au ratio EXACT du logo : le cadre SVG (même viewBox) l'épouse au
          pixel près ; le halo du point déborde via overflow-visible. */}
      <div className="relative inline-flex">
        <Logo className={logoClassName} priority />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${W} ${H}`}
          fill="none"
          aria-hidden="true"
        >
          {/* Piste discrète */}
          <path
            d={TRACK_D}
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeWidth={5}
          />
          {/* Comète (traînée) */}
          <path
            className="geoaino-ll-comet"
            d={TRACK_D}
            pathLength={1000}
            stroke="currentColor"
            strokeOpacity={0.55}
            strokeWidth={7}
            strokeLinecap="round"
          />
          {/* Halo + point */}
          <circle
            className="geoaino-ll-dot"
            r={22}
            fill="currentColor"
            opacity={0.22}
          />
          <circle
            className="geoaino-ll-dot geoaino-ll-dot--core"
            r={9}
            fill="currentColor"
          />
        </svg>
      </div>

      {label != null && (
        <span className="text-xl text-muted-foreground">{label}</span>
      )}
    </div>
  );
}
