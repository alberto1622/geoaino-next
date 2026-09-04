import Image from "next/image";
import { cn } from "@/lib/utils";

// Dimensions intrinsèques du PNG source (public/logo-geoaino.png).
const NATURAL_W = 793;
const NATURAL_H = 315;

interface LogoProps {
  /** Classe de dimensionnement du conteneur — fixe la hauteur (ex. "h-8"). */
  className?: string;
  priority?: boolean;
}

/**
 * Logo GEO-AINO SUPREME, adapté au thème :
 * - thème clair : PNG d'origine (lettrage bleu nuit) ;
 * - thème sombre : variante bi-ton claire (public/logo-geoaino-light.png),
 *   le lettrage #102733 étant illisible sur le fond #0B1417.
 * La bascule est purement CSS (classe .dark sur <html>) : aucun flash, aucun JS.
 */
export function Logo({ className, priority = false }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <Image
        src="/logo-geoaino.png"
        alt="GEO-AINO SUPREME"
        width={NATURAL_W}
        height={NATURAL_H}
        priority={priority}
        className="block h-full w-auto dark:hidden"
      />
      <Image
        src="/logo-geoaino-light.png"
        alt="GEO-AINO SUPREME"
        width={NATURAL_W}
        height={NATURAL_H}
        priority={priority}
        className="hidden h-full w-auto dark:block"
      />
    </span>
  );
}
