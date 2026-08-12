/**
 * shapefile-inventory.ts — inventaire des colonnes .dbf d'un shapefile avant
 * import (variante shapefile de `src/lib/import/inventory.ts`, qui inventorie
 * des CALQUES DXF ; ici on inventorie des COLONNES d'attributs).
 */
import * as shapefile from "shapefile";
import {
  targetFieldsFor,
  proposeFieldMapping,
  type ShapefileTarget,
  type TargetFieldDef,
  type FieldMapping,
} from "./field-mapping";

export interface ShapefileFieldEntry {
  /** Nom de colonne .dbf tel quel (affichage + valeur de mappage). */
  name: string;
  /** Jusqu'à 3 valeurs non vides distinctes rencontrées (aide à la décision). */
  sampleValues: string[];
  nonEmptyCount: number;
}

export interface ShapefileFieldInventory {
  featureCount: number;
  fields: ShapefileFieldEntry[];
  targetFields: TargetFieldDef[];
  proposedMapping: FieldMapping;
}

export async function buildShapefileFieldInventory(
  shpBuf: Buffer,
  dbfBuf: Buffer,
  target: ShapefileTarget,
): Promise<ShapefileFieldInventory> {
  // Lit uniquement le .dbf (pas le .shp) : cette fonction n'énumère que des
  // noms de colonnes et quelques valeurs d'exemple, la géométrie ne sert à
  // rien ici. Sur les gros shapefiles (chemin page d'accueil, 100k+
  // parcelles), parser toute la géométrie via shapefile.read() rien que pour
  // lister les colonnes risquait de dépasser maxDuration=120 de la route.
  const source = await shapefile.openDbf(dbfBuf);
  const byName = new Map<string, { sampleValues: string[]; nonEmptyCount: number }>();
  let featureCount = 0;

  let result = await source.read();
  while (!result.done) {
    featureCount++;
    const props = (result.value ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(props)) {
      const entry = byName.get(name) ?? { sampleValues: [], nonEmptyCount: 0 };
      const str = value === null || value === undefined ? "" : String(value).trim();
      if (str) {
        entry.nonEmptyCount += 1;
        if (entry.sampleValues.length < 3 && !entry.sampleValues.includes(str)) {
          entry.sampleValues.push(str);
        }
      }
      byName.set(name, entry);
    }
    result = await source.read();
  }

  const fields: ShapefileFieldEntry[] = Array.from(byName.entries())
    .map(([name, v]) => ({ name, sampleValues: v.sampleValues, nonEmptyCount: v.nonEmptyCount }))
    .sort((a, b) => b.nonEmptyCount - a.nonEmptyCount);

  const targetFields = targetFieldsFor(target);
  const proposedMapping = proposeFieldMapping(fields.map((f) => f.name), targetFields);

  return { featureCount, fields, targetFields, proposedMapping };
}
