import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { requireSession } from "@/lib/analyses/require-session";

type Params = Promise<{ id: string }>;

export async function DELETE(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const analysisId = parseInt(id);
  const body = await req.json() as { indices: number[] };
  const toDelete = new Set<number>(body.indices ?? []);

  if (toDelete.size === 0) {
    return NextResponse.json({ error: "Aucun indice fourni" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { id: true, geojsonKey: true, geoJsonData: true },
  });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  const rawJson = (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!rawJson) return NextResponse.json({ error: "Données GeoJSON introuvables" }, { status: 404 });

  const fc = JSON.parse(rawJson) as { type: string; features: unknown[] };
  const remaining = fc.features.filter((_, i) => !toDelete.has(i));
  fc.features = remaining;
  const updated = JSON.stringify(fc);

  if (analysis.geojsonKey) {
    await writeGeoJsonByKey(analysis.geojsonKey, updated);
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { totalFeatures: remaining.length },
    });
  } else {
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { geoJsonData: updated, totalFeatures: remaining.length },
    });
  }

  return NextResponse.json({ remaining: remaining.length, deleted: toDelete.size });
}
