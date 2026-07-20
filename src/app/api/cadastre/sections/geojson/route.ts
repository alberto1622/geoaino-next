import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSectionsGeo } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/geojson — limites de sections (tous lots) +
 * points d'étiquette (numéro de section) pour l'affichage sur la carte
 * d'analyse. `boundaries` = polygones ; `labels` = ancres intérieures
 * (ST_PointOnSurface) portant `numSection`/`commune`.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  try {
    const sections = await listSectionsGeo();

    const boundaries: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: sections.map((s) => ({
        type: "Feature" as const,
        id: s.id,
        geometry: s.geomGeoJson,
        properties: { id: s.id, numSection: s.numSection, commune: s.commune },
      })),
    };

    const labels = sections
      .filter((s) => s.labelPoint && Array.isArray(s.labelPoint.coordinates))
      .map((s) => ({
        lng: s.labelPoint!.coordinates[0],
        lat: s.labelPoint!.coordinates[1],
        numSection: s.numSection,
        commune: s.commune,
      }));

    return NextResponse.json({ boundaries, labels });
  } catch (err) {
    console.error("[cadastre/sections/geojson] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
