/**
 * Génération d'un shapefile ZIP (.shp/.dbf/.shx/.prj) pour les parcelles cadastrales.
 * Porté depuis vericad/server/exportShapefile.ts (streaming Express → buffer).
 * Le ZIP est construit en mémoire puis renvoyé par un Route Handler.
 */
import archiver from "archiver";
import { getParcellesForExport, getParcellesMultiSyscols } from "./data";

const PRJ_WGS84 = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;

// ─── DBF ─────────────────────────────────────────────────────────────────────
function buildDbf(rows: Array<Record<string, string | null | undefined>>): Buffer {
  const fields: Array<{ name: string; type: "C" | "N"; length: number }> = [
    { name: "NICAD", type: "C", length: 16 },
    { name: "SYSCOL", type: "C", length: 8 },
    { name: "SECTION", type: "C", length: 3 },
    { name: "PARCELLE", type: "C", length: 5 },
    { name: "COMMUNE", type: "C", length: 50 },
    { name: "REGION", type: "C", length: 40 },
    { name: "DEPT", type: "C", length: 40 },
    { name: "STATUT", type: "C", length: 12 },
    { name: "VERSION", type: "C", length: 4 },
    { name: "SUPERFICIE", type: "C", length: 16 },
    { name: "QUARTIER", type: "C", length: 50 },
    { name: "LOT", type: "C", length: 30 },
    { name: "TITRE", type: "C", length: 40 },
    { name: "NAT_JURI", type: "C", length: 30 },
    { name: "TYPE_DEST", type: "C", length: 30 },
    { name: "CAT_OCUP", type: "C", length: 30 },
    { name: "LON", type: "C", length: 20 },
    { name: "LAT", type: "C", length: 20 },
  ];

  const headerSize = 32 + fields.length * 32 + 1;
  const recordSize = 1 + fields.reduce((s, f) => s + f.length, 0);
  const totalSize = headerSize + rows.length * recordSize + 1;
  const buf = Buffer.alloc(totalSize, 0x20);

  buf[0] = 0x03;
  const now = new Date();
  buf[1] = now.getFullYear() - 1900;
  buf[2] = now.getMonth() + 1;
  buf[3] = now.getDate();
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt16LE(headerSize, 8);
  buf.writeUInt16LE(recordSize, 10);

  fields.forEach((f, i) => {
    const offset = 32 + i * 32;
    const nameBytes = Buffer.from(f.name.padEnd(11, "\0"), "ascii");
    nameBytes.copy(buf, offset);
    buf[offset + 11] = f.type.charCodeAt(0);
    buf.writeUInt8(f.length, offset + 16);
  });
  buf[32 + fields.length * 32] = 0x0d;

  rows.forEach((row, ri) => {
    let pos = headerSize + ri * recordSize;
    buf[pos++] = 0x20;
    for (const f of fields) {
      const val = (row[f.name] ?? "").toString().substring(0, f.length);
      const padded = val.padEnd(f.length, " ");
      buf.write(padded, pos, f.length, "latin1");
      pos += f.length;
    }
  });

  buf[headerSize + rows.length * recordSize] = 0x1a;
  return buf;
}

// ─── SHP + SHX ───────────────────────────────────────────────────────────────
interface Ring {
  points: [number, number][];
}

function parseGeojsonRings(geojson: string | null | undefined): Ring[] {
  if (!geojson) return [];
  try {
    const g = JSON.parse(geojson);
    const geom = g.geometry ?? g;
    if (!geom || !geom.type) return [];
    if (geom.type === "Polygon") {
      return geom.coordinates.map((ring: [number, number][]) => ({ points: ring }));
    }
    if (geom.type === "MultiPolygon") {
      return geom.coordinates.flatMap((poly: [number, number][][]) => poly.map((ring) => ({ points: ring })));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function buildShpShx(rings_per_feature: Ring[][]): { shp: Buffer; shx: Buffer } {
  const recordBuffers: Buffer[] = [];
  let contentLen = 0;

  for (const rings of rings_per_feature) {
    if (!rings.length) {
      const rec = Buffer.alloc(8 + 4);
      rec.writeInt32BE(0, 0);
      rec.writeInt32BE(2, 4);
      rec.writeInt32LE(0, 8);
      recordBuffers.push(rec);
      contentLen += 4 + 2;
      continue;
    }

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let totalPoints = 0;
    for (const ring of rings) {
      totalPoints += ring.points.length;
      for (const [x, y] of ring.points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const contentBytes = 4 + 32 + 4 + 4 + rings.length * 4 + totalPoints * 16;
    const contentWords = contentBytes / 2;

    const rec = Buffer.alloc(8 + contentBytes);
    rec.writeInt32BE(0, 0);
    rec.writeInt32BE(contentWords, 4);
    rec.writeInt32LE(5, 8);
    rec.writeDoubleLE(minX, 12);
    rec.writeDoubleLE(minY, 20);
    rec.writeDoubleLE(maxX, 28);
    rec.writeDoubleLE(maxY, 36);
    rec.writeInt32LE(rings.length, 44);
    rec.writeInt32LE(totalPoints, 48);

    let partOffset = 52;
    let pointOffset = 52 + rings.length * 4;
    let cumPoints = 0;
    for (const ring of rings) {
      rec.writeInt32LE(cumPoints, partOffset);
      partOffset += 4;
      cumPoints += ring.points.length;
    }
    for (const ring of rings) {
      for (const [x, y] of ring.points) {
        rec.writeDoubleLE(x, pointOffset);
        rec.writeDoubleLE(y, pointOffset + 8);
        pointOffset += 16;
      }
    }
    recordBuffers.push(rec);
    contentLen += 4 + contentWords;
  }

  const fileLen = 50 + contentLen;
  const shpHeader = Buffer.alloc(100, 0);
  shpHeader.writeInt32BE(9994, 0);
  shpHeader.writeInt32BE(fileLen, 24);
  shpHeader.writeInt32LE(1000, 28);
  shpHeader.writeInt32LE(5, 32);

  let gMinX = Infinity,
    gMinY = Infinity,
    gMaxX = -Infinity,
    gMaxY = -Infinity;
  for (const rings of rings_per_feature) {
    for (const ring of rings) {
      for (const [x, y] of ring.points) {
        if (x < gMinX) gMinX = x;
        if (x > gMaxX) gMaxX = x;
        if (y < gMinY) gMinY = y;
        if (y > gMaxY) gMaxY = y;
      }
    }
  }
  if (gMinX === Infinity) {
    gMinX = gMinY = gMaxX = gMaxY = 0;
  }
  shpHeader.writeDoubleLE(gMinX, 36);
  shpHeader.writeDoubleLE(gMinY, 44);
  shpHeader.writeDoubleLE(gMaxX, 52);
  shpHeader.writeDoubleLE(gMaxY, 60);

  const shxLen = 50 + rings_per_feature.length * 4;
  const shxHeader = Buffer.alloc(100, 0);
  shpHeader.copy(shxHeader);
  shxHeader.writeInt32BE(shxLen, 24);

  const shxRecords = Buffer.alloc(rings_per_feature.length * 8);
  let shpOffset = 50;
  for (let i = 0; i < recordBuffers.length; i++) {
    const rec = recordBuffers[i];
    const recContentWords = rec.readInt32BE(4);
    shxRecords.writeInt32BE(shpOffset, i * 8);
    shxRecords.writeInt32BE(recContentWords, i * 8 + 4);
    rec.writeInt32BE(i + 1, 0);
    shpOffset += 4 + recContentWords;
  }

  const shp = Buffer.concat([shpHeader, ...recordBuffers]);
  const shx = Buffer.concat([shxHeader, shxRecords]);
  return { shp, shx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDbfRow(p: any): Record<string, string> {
  return {
    NICAD: p.nicad ?? "",
    SYSCOL: p.syscolCommune ?? "",
    SECTION: p.numSection ?? "",
    PARCELLE: p.numParcelle ?? "",
    COMMUNE: p.nomCommune ?? "",
    REGION: p.region ?? "",
    DEPT: p.departement ?? "",
    STATUT: p.statut ?? "",
    VERSION: p.version ?? "",
    SUPERFICIE: p.superficie != null ? String(p.superficie) : "",
    QUARTIER: p.quartier ?? "",
    LOT: p.numLot ?? "",
    TITRE: p.titreParce ?? "",
    NAT_JURI: p.natJuri ?? "",
    TYPE_DEST: p.typeDestin ?? "",
    CAT_OCUP: p.catOcup ?? "",
    LON: p.longitude != null ? String(p.longitude) : "",
    LAT: p.latitude != null ? String(p.latitude) : "",
  };
}

function archiveToBuffer(appendFn: (archive: archiver.Archiver) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on("data", (d: Buffer) => chunks.push(d));
    archive.on("warning", (err) => {
      if ((err as { code?: string }).code !== "ENOENT") reject(err);
    });
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    appendFn(archive);
    void archive.finalize();
  });
}

export interface ZipResult {
  filename: string;
  buffer: Buffer;
}

/**
 * Construit le shapefile ZIP des parcelles d'une commune. Retourne null si aucune parcelle.
 */
export async function buildShapefileZip(syscol: string): Promise<ZipResult | null> {
  const syscolPadded = syscol.padStart(8, "0");
  const rows = await getParcellesForExport(syscolPadded);
  if (!rows.length) return null;

  const dbfRows = rows.map(toDbfRow);
  const geometries = rows.map((p) => parseGeojsonRings(p.geojson));

  const dbfBuf = buildDbf(dbfRows);
  const { shp, shx } = buildShpShx(geometries);
  const prjBuf = Buffer.from(PRJ_WGS84, "ascii");

  const nomCommune = (rows[0].nomCommune ?? syscolPadded).replace(/[^a-zA-Z0-9_\-]/g, "_").toUpperCase();
  const baseName = `PARCELLES_${nomCommune}_${syscolPadded}`;

  const buffer = await archiveToBuffer((archive) => {
    archive.append(shp, { name: `${baseName}.shp` });
    archive.append(shx, { name: `${baseName}.shx` });
    archive.append(dbfBuf, { name: `${baseName}.dbf` });
    archive.append(prjBuf, { name: `${baseName}.prj` });
  });

  return { filename: `${baseName}.zip`, buffer };
}

/**
 * Construit un ZIP multi-communes (un sous-dossier shapefile par commune).
 */
export async function buildShapefileMultiZip(syscols: string[]): Promise<ZipResult | null> {
  const allRows = await getParcellesMultiSyscols(syscols);
  if (!allRows.length) return null;

  const bySyscol = new Map<string, typeof allRows>();
  for (const p of allRows) {
    const key = p.syscolCommune ?? "INCONNU";
    if (!bySyscol.has(key)) bySyscol.set(key, []);
    bySyscol.get(key)!.push(p);
  }

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const buffer = await archiveToBuffer((archive) => {
    for (const [syscol, rows] of Array.from(bySyscol.entries())) {
      const dbfRows = rows.map(toDbfRow);
      const geometries = rows.map((p) => parseGeojsonRings(p.geojson));
      const dbfBuf = buildDbf(dbfRows);
      const { shp, shx } = buildShpShx(geometries);
      const prjBuf = Buffer.from(PRJ_WGS84, "ascii");
      const nomCommune = (rows[0].nomCommune ?? syscol).replace(/[^a-zA-Z0-9_\-]/g, "_").toUpperCase();
      const baseName = `PARCELLES_${nomCommune}_${syscol}`;
      archive.append(shp, { name: `${baseName}/${baseName}.shp` });
      archive.append(shx, { name: `${baseName}/${baseName}.shx` });
      archive.append(dbfBuf, { name: `${baseName}/${baseName}.dbf` });
      archive.append(prjBuf, { name: `${baseName}/${baseName}.prj` });
    }
  });

  return { filename: `PARCELLES_MULTI_${dateStr}.zip`, buffer };
}
