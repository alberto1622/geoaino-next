import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const GADM_URLS: Record<string, string> = {
  "1": "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SEN_1.json",
  "2": "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SEN_2.json",
  "3": "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SEN_3.json",
};

const LEVEL_TO_TYPE: Record<string, "REGION" | "DEPARTEMENT" | "COMMUNE"> = {
  "1": "REGION",
  "2": "DEPARTEMENT",
  "3": "COMMUNE",
};

const LEVEL_NAMES: Record<string, string> = {
  "1": "Régions du Sénégal",
  "2": "Départements du Sénégal",
  "3": "Communes du Sénégal",
};

type Params = Promise<{ level: string }>;

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const { level } = await params;

  if (!GADM_URLS[level]) {
    return NextResponse.json({ error: "Niveau invalide (1, 2 ou 3)" }, { status: 400 });
  }

  const layerType = LEVEL_TO_TYPE[level];

  // Check DB cache
  const existing = await prisma.adminLayer.findFirst({
    where: { layerType, source: "GADM_4.1" },
    select: { geojsonData: true },
  });

  if (existing?.geojsonData) {
    return new NextResponse(existing.geojsonData, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
    });
  }

  // Fetch from GADM
  let data: string;
  try {
    const res = await fetch(GADM_URLS[level], { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`GADM HTTP ${res.status}`);
    data = await res.text();
  } catch (err) {
    return NextResponse.json(
      { error: `Impossible de télécharger GADM niveau ${level}: ${String(err)}` },
      { status: 502 }
    );
  }

  // Store in DB
  const row = await prisma.adminLayer.findFirst({ where: { layerType, source: "GADM_4.1" }, select: { id: true } });
  if (row) {
    await prisma.adminLayer.update({ where: { id: row.id }, data: { geojsonData: data } });
  } else {
    await prisma.adminLayer.create({
      data: { name: LEVEL_NAMES[level], layerType, source: "GADM_4.1", geojsonData: data },
    });
  }

  return new NextResponse(data, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
  });
}
