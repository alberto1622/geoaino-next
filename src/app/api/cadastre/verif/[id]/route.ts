import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * GET /api/cadastre/verif/[id] — détail d'une vérification.
 *
 * Lecture ouverte à tout utilisateur connecté (historique partagé, cf. la
 * route parente).
 */
export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  }

  try {
    const v = await prisma.cadVerification.findUnique({
      where: { id },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!v) {
      return NextResponse.json({ error: "Vérification introuvable" }, { status: 404 });
    }

    return NextResponse.json({
      ...v,
      superficieCalculee: Number(v.superficieCalculee),
      superficieDeclaree:
        v.superficieDeclaree === null ? null : Number(v.superficieDeclaree),
      perimetreM: Number(v.perimetreM),
      tolerancePct: Number(v.tolerancePct),
      tolerancePlancher: Number(v.tolerancePlancher),
    });
  } catch (e) {
    console.error("Erreur lecture d'une vérification :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}
