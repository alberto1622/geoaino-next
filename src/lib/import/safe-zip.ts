/**
 * safe-zip.ts — extraction bornée des archives ZIP envoyées par les
 * utilisateurs (protection « bombe ZIP »).
 *
 * Une archive de quelques Mo peut se décompresser en dizaines de Go et saturer
 * la mémoire du serveur. Les tailles déclarées dans l'en-tête ZIP peuvent être
 * falsifiées : on compte donc les octets réellement produits pendant la
 * décompression (flux) et on interrompt dès que le budget de l'archive est
 * dépassé. Le budget est partagé entre toutes les entrées lues d'une même
 * archive.
 */
import type JSZip from "jszip";

/** Taille décompressée maximale d'une archive, en Mo (défaut 1500 : un plan
 *  cadastral DXF réel fait ~300 Mo décompressé). Ajustable : `MAX_UNZIPPED_MB`. */
const MAX_UNZIPPED_BYTES = (Number(process.env.MAX_UNZIPPED_MB) || 1500) * 1024 * 1024;
/** Nombre maximal d'entrées d'une archive. */
const MAX_ENTRIES = 10_000;

export class ZipTooLargeError extends Error {
  constructor(detail: string) {
    super(`Archive ZIP refusée : ${detail}.`);
    this.name = "ZipTooLargeError";
  }
}

/** Refuse les archives au nombre d'entrées anormal (avant toute lecture). */
export function assertZipEntryCount(zip: JSZip): void {
  const count = Object.keys(zip.files).length;
  if (count > MAX_ENTRIES) {
    throw new ZipTooLargeError(`${count} entrées (maximum ${MAX_ENTRIES})`);
  }
}

/**
 * Lecteur à budget partagé : chaque appel à `buffer`/`text` décompte les
 * octets extraits du budget total de l'archive.
 */
export function createZipReader(maxTotalBytes: number = MAX_UNZIPPED_BYTES) {
  let used = 0;

  function buffer(file: JSZip.JSZipObject): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = file.nodeStream("nodebuffer");
      let aborted = false;
      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        used += chunk.length;
        if (used > maxTotalBytes) {
          aborted = true;
          stream.pause();
          stream.removeAllListeners("data");
          reject(
            new ZipTooLargeError(
              `contenu décompressé supérieur à ${Math.round(maxTotalBytes / 1024 / 1024)} Mo`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!aborted) resolve(Buffer.concat(chunks));
      });
      stream.on("error", (err: Error) => {
        if (!aborted) reject(err);
      });
    });
  }

  async function text(file: JSZip.JSZipObject): Promise<string> {
    return (await buffer(file)).toString("utf8");
  }

  return { buffer, text };
}
