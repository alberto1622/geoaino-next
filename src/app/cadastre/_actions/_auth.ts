import { auth } from "@/lib/auth";

/**
 * Garde d'authentification pour les Server Actions du module Cadastre.
 * Remplace le `protectedProcedure` tRPC de vericad.
 * Retourne l'identifiant (String/cuid) de l'utilisateur connecté.
 */
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
