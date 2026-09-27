/**
 * upload-guard.ts — contrôles communs à toutes les routes qui reçoivent des
 * fichiers géographiques (session, débit, taille, extension).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Taille maximale d'un envoi (tous fichiers confondus). Les plans cadastraux
 * DXF réels atteignent ~300 Mo : 500 Mo par défaut, aligné sur
 * `serverActions.bodySizeLimit` (next.config.ts). Ajustable via `MAX_UPLOAD_MB`.
 */
export const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;

/** Extensions acceptées (le type MIME envoyé par le navigateur n'est pas pris en compte). */
const ALLOWED_EXTENSIONS = new Set([
  ".dxf", ".dgn", ".zip", ".shp", ".dbf", ".prj", ".shx", ".cpg",
  ".geojson", ".json", ".kml", ".csv",
]);

/** Envois de fichiers autorisés par utilisateur et par fenêtre. */
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function tooLarge(): NextResponse {
  return NextResponse.json(
    { error: `Fichier trop volumineux (maximum ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} Mo).` },
    { status: 413 },
  );
}

/**
 * À appeler AVANT `req.formData()` : exige une session, applique la limite de
 * débit par utilisateur et rejette tôt un corps annoncé trop gros
 * (`Content-Length`). Renvoie `{ userId }` ou la réponse d'erreur à retourner.
 */
export async function guardUploadRequest(
  req: NextRequest,
): Promise<{ userId: string } | { response: NextResponse }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { response: NextResponse.json({ error: "Authentification requise" }, { status: 401 }) };
  }

  const rl = rateLimit(`upload:${userId}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  if (!rl.allowed) {
    return {
      response: NextResponse.json(
        { error: "Trop d'envois de fichiers. Réessayez dans quelques minutes." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      ),
    };
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return { response: tooLarge() };
  }
  return { userId };
}

/**
 * Vérifie les fichiers réellement reçus (taille cumulée réelle, `Content-Length`
 * pouvant être absent ou falsifié, et extensions autorisées). Renvoie la
 * réponse d'erreur à retourner, sinon `null`.
 */
export function validateUploadedFiles(files: File[]): NextResponse | null {
  let total = 0;
  for (const f of files) {
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "Champ de fichier invalide." }, { status: 400 });
    }
    if (!ALLOWED_EXTENSIONS.has(extensionOf(f.name))) {
      return NextResponse.json(
        { error: `Type de fichier non autorisé : ${extensionOf(f.name) || "(sans extension)"}.` },
        { status: 415 },
      );
    }
    total += f.size;
  }
  return total > MAX_UPLOAD_BYTES ? tooLarge() : null;
}
