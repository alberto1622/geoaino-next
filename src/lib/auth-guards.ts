import { auth } from "@/lib/auth";

/**
 * Gardes d'authentification pour les Server Actions et pages.
 * Remplace le `protectedProcedure` tRPC de vericad.
 */

/** Retourne l'identifiant (String/cuid) de l'utilisateur connecté, sinon lève. */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    throw new Error("Authentification requise pour cette opération.");
  }
  return userId;
}

/** Retourne l'identifiant utilisateur si connecté, sinon undefined (procédures publiques). */
export async function optionalUserId(): Promise<string | undefined> {
  const session = await auth();
  return (session?.user as { id?: string } | undefined)?.id;
}

/**
 * Garde renforcée pour les opérations destructives ou de masse (suppressions de
 * lots, migrations, basculements batch, gestion des comptes) : exige le rôle ADMIN.
 */
export async function requireAdmin(): Promise<string> {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user?.id) {
    throw new Error("Authentification requise pour cette opération.");
  }
  if (user.role !== "ADMIN") {
    throw new Error("Opération réservée aux administrateurs.");
  }
  return user.id;
}
