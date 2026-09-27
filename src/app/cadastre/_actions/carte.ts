"use server";

import { z } from "zod";
import { requireUserId } from "./_auth";
import {
  getParcelleByCoords,
  getParcellesBySyscol,
  getSectionsWithGeom,
  getAllSectionsWithGeom,
  getParcelleByNicad,
  getParcellesCountBySyscol,
} from "@/lib/cadastre/data";

const syscolSchema = z.string().trim().min(1).max(8);
const versionSchema = z.enum(["2013", "2026"]).optional();

const coordsSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  radiusKm: z.number().positive().max(5).optional(),
});
const bySyscolSchema = z.object({
  syscol: syscolSchema,
  limit: z.number().int().min(1).max(10_000).optional(),
  version: versionSchema,
});
const allSectionsSchema = z.object({ limit: z.number().int().min(1).max(5_000).optional() }).optional();
const nicadSchema = z.object({ nicad: z.string().trim().min(1).max(32) });

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
  await requireUserId();
  const { lat, lng, radiusKm } = coordsSchema.parse(input);
  const parcelle = await getParcelleByCoords(lat, lng, radiusKm ?? 0.2);
  if (!parcelle) return null;
  return { ...parcelle, nicadDisplay: nicadDisplay(parcelle.nicad) };
}

export async function parcellesBySyscol(input: {
  syscol: string;
  limit?: number;
  version?: "2013" | "2026";
}) {
  await requireUserId();
  const { syscol, limit, version } = bySyscolSchema.parse(input);
  return getParcellesBySyscol(syscol, limit ?? 1000, version);
}

export async function sectionsBySyscol(input: { syscol: string }) {
  await requireUserId();
  return getSectionsWithGeom(syscolSchema.parse(input.syscol));
}

export async function allSections(input?: { limit?: number }) {
  await requireUserId();
  return getAllSectionsWithGeom(allSectionsSchema.parse(input)?.limit ?? 500);
}

export async function parcelleByNicad(input: { nicad: string }) {
  await requireUserId();
  const p = await getParcelleByNicad(nicadSchema.parse(input).nicad);
  if (!p) return null;
  return { ...p, nicadDisplay: nicadDisplay(p.nicad) };
}

export async function parcellesCount() {
  await requireUserId();
  return getParcellesCountBySyscol();
}
