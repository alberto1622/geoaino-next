/**
 * Ventile, par calque, les types d'entités géométriques clés de l'espace
 * modèle (LINE, LWPOLYLINE, POLYLINE, 3DFACE, HATCH, closed vs open), pour
 * savoir où se trouvent les limites de parcelles et si des surfaces sont
 * dessinées dans un type ignoré par le lecteur natif (3DFACE, HATCH).
 * Usage : bun scripts/inspect-thies-3dface.ts [chemin.dxf]
 */
import * as fs from "fs";
import * as readline from "readline";

const file =
  process.argv[2] ||
  "uploads/imports/1782995610003_PLAN_CADASTRAL_THIES_FINAL01-10-2025.dxf";

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let section: string | null = null;
  let pendingSectionName = false;

  // Pour l'entité courante (ENTITIES uniquement)
  let curType: string | null = null;
  let curLayer = "";
  let curClosed = false;

  // Comptages : layer -> type(+closed) -> n
  const byLayerType = new Map<string, Map<string, number>>();

  const bump = (layer: string, key: string) => {
    let m = byLayerType.get(layer);
    if (!m) byLayerType.set(layer, (m = new Map()));
    m.set(key, (m.get(key) ?? 0) + 1);
  };

  const flush = () => {
    if (section === "ENTITIES" && curType) {
      if (curType === "LWPOLYLINE" || curType === "POLYLINE") {
        bump(curLayer, `${curType}:${curClosed ? "closed" : "open"}`);
      } else if (["LINE", "3DFACE", "HATCH", "SOLID", "REGION"].includes(curType)) {
        bump(curLayer, curType);
      }
    }
  };

  let code: string | null = null;
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    if (lineNo % 2 === 1) {
      code = raw.trim();
      continue;
    }
    const value = raw;
    const c = code!;

    if (c === "0" && value.trim() === "SECTION") {
      pendingSectionName = true;
      continue;
    }
    if (pendingSectionName && c === "2") {
      section = value.trim();
      pendingSectionName = false;
      continue;
    }
    if (c === "0" && value.trim() === "ENDSEC") {
      flush();
      section = null;
      curType = null;
      continue;
    }

    if (c === "0") {
      flush();
      curType = value.trim();
      curLayer = "";
      curClosed = false;
      continue;
    }
    if (c === "8") {
      curLayer = value.trim();
      continue;
    }
    if (c === "70" && curType) {
      curClosed = (parseInt(value, 10) & 1) === 1;
      continue;
    }
  }
  flush();

  // Affiche les calques d'intérêt (parcelles/sections/tf) + tout calque avec 3DFACE/HATCH
  const rows: Array<[string, string]> = [];
  for (const [layer, m] of byLayerType) {
    const parts = Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`);
    rows.push([layer, parts.join("  ")]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  console.log("=== Types géométriques par calque (ENTITIES) ===");
  for (const [layer, parts] of rows) {
    console.log(`\n[${layer}]\n   ${parts}`);
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
