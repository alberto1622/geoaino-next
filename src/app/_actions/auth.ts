"use server";

import { signOut } from "@/lib/auth";

/**
 * Déconnexion via Server Action : gère le jeton CSRF et la redirection
 * (un POST HTML brut vers /api/auth/signout échoue avec MissingCSRF).
 */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
