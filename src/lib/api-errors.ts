/**
 * api-errors.ts — message d'erreur renvoyé au client par les routes API.
 *
 * En développement : détail complet (`String(err)`), pour le débogage.
 * En production : on garde les messages métier levés par l'application
 * (ex. « Aucun fichier SHP, GeoJSON, DXF ou DGN trouvé dans le ZIP ») mais on
 * masque ce qui trahit l'infrastructure : erreurs Prisma (requêtes, schéma),
 * erreurs système Node (`code` ENOENT/EACCES… avec chemins disque) et tout ce
 * qui n'est pas une `Error`. Le détail reste dans les logs serveur
 * (`console.error` du `catch` appelant).
 */
const GENERIC = "Erreur interne du serveur.";
const MAX_LENGTH = 300;

export function publicErrorMessage(err: unknown): string {
  if (process.env.NODE_ENV !== "production") return String(err);
  if (!(err instanceof Error)) return GENERIC;
  if (err.name.startsWith("Prisma")) return GENERIC;
  if (typeof (err as NodeJS.ErrnoException).code === "string") return GENERIC;

  const firstLine = err.message.split("\n")[0].trim();
  if (!firstLine) return GENERIC;
  return firstLine.length > MAX_LENGTH ? `${firstLine.slice(0, MAX_LENGTH)}…` : firstLine;
}
