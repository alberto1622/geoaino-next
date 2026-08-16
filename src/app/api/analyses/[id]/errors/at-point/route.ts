import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/analyses/require-session";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

interface Row {
  id: number;
  errorType: string;
  severity: string;
  nicad1: string | null;
  nicad2: string | null;
  description: string | null;
  geometry: unknown;
  area: unknown;
  confidence: unknown;
  corrected: boolean;
}

/**
 * GET /api/analyses/[id]/errors/at-point?lng=&lat=
 *
 * Retrouve l'erreur MISSING_NICAD/SHORT_NICAD dont la géométrie contient le
 * point donné — repli serveur pour le pont carte → panneau de correction
 * (`MapAnalysisClient.handleFeatureClick`) quand l'erreur n'est pas dans les
 * `analysis.errors` embarqués à la page (plafonnés à `ERROR_RENDER_LIMIT`,
 * cf. `map/[analysisId]/page.tsx`) : un gros DXF peut porter 100k+ NICAD
 * manquants, largement au-delà de ce plafond. `geometry` n'a pas de colonne
 * PostGIS dédiée (type `Json`) : ST_Contains est calculé à la volée, borné à
 * un type d'erreur + une analyse — coût acceptable pour un clic isolé, pas
 * pour un usage en boucle.
 */
export async function GET(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return Response.json({ error: "ID invalide" }, { status: 400 });
  }

  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");
  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return Response.json({ error: "Coordonnées invalides" }, { status: 400 });
  }

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, "errorType", severity, nicad1, nicad2, description, geometry, area, confidence, corrected
    FROM "TopologicalError"
    WHERE "analysisId" = ${analysisId}
      AND "errorType" IN ('MISSING_NICAD', 'SHORT_NICAD')
      AND corrected = false
      AND geometry IS NOT NULL
      AND ST_Contains(
        ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), 4326),
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      )
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return Response.json({ match: null });

  return Response.json({
    match: {
      id: row.id,
      errorType: row.errorType,
      severity: row.severity,
      nicad1: row.nicad1,
      nicad2: row.nicad2,
      description: row.description,
      geometry: row.geometry,
      area: row.area != null ? Number(row.area) : null,
      confidence: Number(row.confidence),
      corrected: row.corrected,
    },
  });
}
