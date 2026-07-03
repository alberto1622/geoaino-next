/**
 * source.ts — résolution du fichier source d'un import Microstation.
 *
 * Détermine le type (DXF/DGN) à partir du nom, en dépliant un éventuel ZIP
 * conteneur. Partagé par l'endpoint d'inventaire des calques et l'endpoint de
 * démarrage de job.
 */
import JSZip from "jszip";
import { convertDgnToDxf } from "../dgn-to-dxf";
import type { SourceType } from "./jobs";

export function sourceTypeFromName(name: string): SourceType | null {
  const n = name.toLowerCase();
  if (n.endsWith(".dxf")) return "DXF";
  if (n.endsWith(".dgn")) return "DGN";
  return null;
}

export interface ResolvedSource {
  buffer: Buffer;
  fileName: string;
  sourceType: SourceType;
}

/** Résout le buffer + le type source d'un `File`, en dépliant un éventuel ZIP. */
export async function resolveSource(file: File): Promise<ResolvedSource | null> {
  const buf = Buffer.from(await file.arrayBuffer());
  const direct = sourceTypeFromName(file.name);
  if (direct) return { buffer: buf, fileName: file.name, sourceType: direct };

  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
    const inner =
      names.find((f) => f.toLowerCase().endsWith(".dxf")) ??
      names.find((f) => f.toLowerCase().endsWith(".dgn"));
    if (inner) {
      const innerBuf = Buffer.from(await zip.files[inner].async("arraybuffer"));
      return { buffer: innerBuf, fileName: inner, sourceType: sourceTypeFromName(inner)! };
    }
  }
  return null;
}

/** Retourne un buffer DXF exploitable à partir d'un buffer source (DXF ou DGN). */
export async function toDxfBuffer(buf: Buffer, sourceType: SourceType): Promise<Buffer> {
  if (sourceType === "DGN") {
    const dxf = await convertDgnToDxf(buf);
    if (!dxf) {
      throw new Error(
        "Conversion DGN→DXF indisponible (configurer DGN_TO_DXF_BIN) — traitement impossible.",
      );
    }
    return dxf;
  }
  return buf;
}
