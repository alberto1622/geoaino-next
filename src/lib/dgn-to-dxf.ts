import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, rm, mkdtemp } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// ── Conversion DGN → DXF via un convertisseur externe configurable ───────────
//
// Aucun composant embarqué ne lit le DGN v8 (Microstation V8) :
//   - GDAL standard (ogr2ogr) ne gère que le DGN v7 ;
//   - ODA File Converter ne gère que DWG/DXF (pas le DGN).
// Le DGN v8 exige un outil tiers capable de le LIRE. Plutôt que de coder en dur
// un outil précis, on délègue à une commande externe que l'administrateur
// configure pour pointer sur le convertisseur dont il dispose. Le DXF produit
// est ensuite routé vers le pipeline d'ingestion DXF (calques, NICAD, jointures).
//
// Variables d'environnement :
//   DGN_TO_DXF_BIN   : exécutable du convertisseur (obligatoire pour activer).
//   DGN_TO_DXF_ARGS  : gabarit d'arguments, séparés par des espaces. Les jetons
//                      {input} et {output} sont remplacés par les chemins des
//                      fichiers temporaires (chaque jeton = un seul argument,
//                      donc les chemins avec espaces sont supportés).
//                      Défaut : "-f DXF -skipfailures {output} {input}" (ogr2ogr).
//
// Exemples de configuration :
//   • GDAL compilé avec le driver DGNv8 (librairies ODA) :
//       DGN_TO_DXF_BIN = C:\gdal-dgnv8\ogr2ogr.exe
//       DGN_TO_DXF_ARGS = -f DXF -skipfailures {output} {input}
//   • MicroStation en batch (via un script .bat wrapper que vous écrivez) :
//       DGN_TO_DXF_BIN = C:\scripts\mstn-dgn2dxf.bat
//       DGN_TO_DXF_ARGS = {input} {output}

const execFileAsync = promisify(execFile);

const DEFAULT_ARGS = "-f DXF -skipfailures {output} {input}";

/** Indique si un convertisseur DGN→DXF externe est configuré. */
export function isDgnConverterConfigured(): boolean {
  const bin = process.env.DGN_TO_DXF_BIN?.trim();
  return !!bin && existsSync(bin);
}

/**
 * Convertit un buffer DGN (v7 ou v8) en buffer DXF via le convertisseur externe
 * configuré (`DGN_TO_DXF_BIN`).
 * - Retourne `null` si aucun convertisseur n'est configuré/trouvé (le caller
 *   peut alors retomber sur GDAL pour le DGN v7).
 * - Lève une erreur si la conversion échoue (DGN illisible / outil défaillant).
 */
export async function convertDgnToDxf(buffer: Buffer): Promise<Buffer | null> {
  const bin = process.env.DGN_TO_DXF_BIN?.trim();
  if (!bin || !existsSync(bin)) return null;

  const argsTemplate = (process.env.DGN_TO_DXF_ARGS?.trim() || DEFAULT_ARGS).split(/\s+/);

  const dir = await mkdtemp(path.join(tmpdir(), "geo-dgn-"));
  const input = path.join(dir, "input.dgn");
  const output = path.join(dir, "output.dxf");

  try {
    await writeFile(input, buffer);

    // Chaque jeton reste un seul argument → chemins avec espaces préservés.
    const args = argsTemplate.map((tok) =>
      tok.replace("{input}", input).replace("{output}", output)
    );

    await execFileAsync(bin, args, { timeout: 300000, maxBuffer: 1024 * 1024 * 100 });

    if (existsSync(output)) return await readFile(output);

    // Certains convertisseurs nomment la sortie d'après l'entrée (input.dxf) ou
    // écrivent dans le dossier ; on récupère le premier .dxf trouvé.
    const produced = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".dxf"));
    if (produced) return await readFile(path.join(dir, produced));

    throw new Error(
      "Le convertisseur DGN_TO_DXF_BIN n'a produit aucun fichier DXF (DGN illisible ou commande incorrecte ?)."
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
