import { NextResponse } from "next/server";
import { requireSession } from "@/lib/analyses/require-session";
import { isBasemapAvailable } from "@/lib/basemap-tiles";

/** GET /api/tiles/status — le fond de carte local est-il disponible ? */
export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  return NextResponse.json({ available: isBasemapAvailable() });
}
