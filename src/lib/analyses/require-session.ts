import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Garde d'authentification partagée par toutes les routes `/api/analyses/[id]/*`.
 * Politique volontairement simple (session requise, pas de contrôle de
 * propriétaire) : `GET /api/analyses` liste déjà toutes les analyses sans
 * filtrage par utilisateur — c'est un espace de travail partagé entre membres
 * connectés, pas un cloisonnement par compte. Renvoie une 401 à retourner
 * telle quelle si aucune session n'est active, sinon `null`.
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  return null;
}
