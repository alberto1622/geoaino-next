/**
 * Gardes d'authentification des Server Actions du module Cadastre.
 * Implémentation partagée dans `src/lib/auth-guards.ts` (utilisée aussi par
 * la gestion des comptes /admin) ; ce fichier ne fait que réexporter.
 */
export { requireUserId, optionalUserId, requireAdmin } from "@/lib/auth-guards";
