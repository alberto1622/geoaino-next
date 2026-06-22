"use server";

import {
  getParcelleByCoords,
  getParcellesBySyscol,
  getSectionsWithGeom,
  getAllSectionsWithGeom,
  getParcelleByNicad,
  getParcellesCountBySyscol,
} from "@/lib/cadastre/data";

function nicadDisplay(nicad: string | null | undefined) {
  return nicad
    ? {
        syscol: nicad.substring(0, 8),
        section: nicad.substring(8, 11),
        parcelle: nicad.substring(11, 16),
        complet: nicad,
      }
    : null;
}

export async function parcelleByCoords(input: { lat: number; lng: number; radiusKm?: number }) {
  const parcelle = await getParcelleByCoords(input.lat, input.lng, input.radiusKm ?? 0.2);
  if (!parcelle) return null;
  return { ...parcelle, nicadDisplay: nicadDisplay(parcelle.nicad) };
}

export async function parcellesBySyscol(input: {
  syscol: string;
  limit?: number;
  version?: "2013" | "2026";
}) {
  return getParcellesBySyscol(input.syscol, input.limit ?? 1000, input.version);
}

export async function sectionsBySyscol(input: { syscol: string }) {
  return getSectionsWithGeom(input.syscol);
}

export async function allSections(input?: { limit?: number }) {
  return getAllSectionsWithGeom(input?.limit ?? 500);
}

export async function parcelleByNicad(input: { nicad: string }) {
  const p = await getParcelleByNicad(input.nicad);
  if (!p) return null;
  return { ...p, nicadDisplay: nicadDisplay(p.nicad) };
}

export async function parcellesCount() {
  return getParcellesCountBySyscol();
}
