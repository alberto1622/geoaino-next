import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listAdminMismatches } from "@/lib/cadastre/admin-mismatch-data";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/admin-mismatches[?sourceFichier=...] —
 * débordements détectés entre les sections et les limites administratives
 * (commune/département/région, `cad_communes_2026`) pour le rendu et la
 * liste de corrections de la page /cadastre/sections. Même contrat que
 * `overlaps/route.ts` (`sourceFichier` répétable, absent = tous les lots).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const sourceFichierList = req.nextUrl.searchParams.getAll("sourceFichier");
  const sourceFichier = sourceFichierList.length > 0 ? sourceFichierList : null;
  try {
    const mismatches = await listAdminMismatches(sourceFichier);
    return NextResponse.json({ sourceFichier, mismatches });
  } catch (err) {
    console.error("[cadastre/sections/admin-mismatches] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
