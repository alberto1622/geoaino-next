/**
 * Recherche NICAD → bornes, adaptée de cadex-next `referentiel.ts`.
 *
 * cadex-next rejoue `orderedBornes()` + `reprojectPoint()` — le code même qui a
 * imprimé le tableau d'un Plan Morcellement — pour retrouver, au chiffre près,
 * les coordonnées portées sur un plan déjà émis. geoaino-next ne génère pas ce
 * type de plan : il n'y a pas de tableau papier à reproduire à l'identique.
 *
 * Cette voie est donc une **commodité de saisie**, pas une relecture de
 * document : elle extrait l'anneau extérieur de la géométrie actuellement
 * enregistrée pour ce NICAD dans `CadParcelle` (calque référentiel importé
 * depuis les DXF/shapefiles cadastraux) et le reprojette en UTM 28N. La
 * renumérotation canonique (B1 = Y maximal) est de toute façon recalculée par
 * `verifier()` (core.ts), donc l'ordre de sortie ici n'a pas besoin d'être
 * exact — seules les coordonnées comptent.
 *
 * `superficieDeclaree` reprend `CadParcelle.superficie` : c'est elle qui fait
 * travailler `ECART_SUPERFICIE` en confrontant une ressaisie au référentiel
 * actuel.
 */
import proj4 from "proj4";
import { prisma } from "@/lib/prisma";
import type { Borne } from "./types";

proj4.defs("EPSG:32628", "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs +type=crs");

type Position = [number, number];
type Ring = Position[];

/**
 * Aire (non signée) d'un anneau en coordonnées géographiques — assez pour
 * comparer des anneaux entre eux (choisir le plus grand d'un MultiPolygon),
 * pas destinée à une mesure métrique.
 */
function aireApprox(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(s / 2);
}

/** Anneau extérieur de la géométrie (le plus grand, si MultiPolygon). */
function anneauExterieur(geojson: string | object | null | undefined): Ring | null {
  if (!geojson) return null;
  let g: unknown;
  try {
    g = typeof geojson === "string" ? JSON.parse(geojson) : geojson;
  } catch {
    return null;
  }
  const geom = (g as { geometry?: unknown })?.geometry ?? g;
  const type = (geom as { type?: string } | undefined)?.type;
  const coords = (geom as { coordinates?: unknown } | undefined)?.coordinates;
  if (!type || !coords) return null;

  let anneaux: Ring[] = [];
  if (type === "Polygon") {
    anneaux = [(coords as Ring[])[0]];
  } else if (type === "MultiPolygon") {
    anneaux = (coords as Ring[][]).map((poly) => poly[0]).filter(Boolean);
  } else {
    return null;
  }
  if (anneaux.length === 0) return null;
  return anneaux.reduce((a, b) => (aireApprox(b) > aireApprox(a) ? b : a));
}

export type BornesReferentiel = {
  bornes: Borne[];
  superficieDeclaree?: number;
  /** Pour affichage : commune/section/numéro de la parcelle trouvée. */
  syscolCommune: string;
  numSection: string;
  numParcelle: string;
};

/**
 * Retrouve une parcelle par NICAD et renvoie ses sommets en UTM 28N
 * (EPSG:32628), prêts à passer à `verifier()`. `null` si le NICAD est
 * introuvable ou sans géométrie exploitable.
 */
export async function bornesDuReferentiel(
  nicad: string,
): Promise<BornesReferentiel | null> {
  const parcelle = await prisma.cadParcelle.findFirst({
    where: { nicad },
    orderBy: { updatedAt: "desc" },
  });
  if (!parcelle) return null;

  const ring = anneauExterieur(parcelle.geojson);
  if (!ring || ring.length < 4) return null; // anneau fermé : >= 3 sommets distincts + fermeture

  // L'anneau GeoJSON est fermé (premier = dernier sommet) : on écarte la
  // fermeture explicite, `core.ts` la réintroduit implicitement partout.
  const sommets = ring.slice(0, -1);

  const bornes: Borne[] = sommets.map(([lon, lat], i) => {
    const [x, y] = proj4("EPSG:4326", "EPSG:32628", [lon, lat]);
    return { pt: `B${i + 1}`, x, y };
  });

  return {
    bornes,
    superficieDeclaree: parcelle.superficie != null ? Number(parcelle.superficie) : undefined,
    syscolCommune: parcelle.syscolCommune,
    numSection: parcelle.numSection,
    numParcelle: parcelle.numParcelle,
  };
}
