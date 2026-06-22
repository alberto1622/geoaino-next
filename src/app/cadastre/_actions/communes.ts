"use server";

import {
  getCommunes2013,
  getCommunes2026,
  getCommunes2026Light,
  getRegions2026,
  getRegions2013,
  getCommunes2013ByRegion,
  getCommune2013BySyscol,
  getCommune2026BySyscol,
} from "@/lib/cadastre/data";

export async function listCommunes2013() {
  return getCommunes2013();
}

export async function listCommunes2026(input?: { region?: string }) {
  return getCommunes2026Light(input?.region);
}

export async function listCommunes2026WithGeom(input?: { region?: string }) {
  return getCommunes2026(input?.region);
}

export async function listRegions2026() {
  return getRegions2026();
}

export async function listRegions2013() {
  return getRegions2013();
}

export async function listCommunes2013ByRegion(input?: { region?: string }) {
  return getCommunes2013ByRegion(input?.region);
}

export async function getCommuneBySyscol2013(input: { syscol: string }) {
  return (await getCommune2013BySyscol(input.syscol)) ?? null;
}

export async function getCommuneBySyscol2026(input: { syscol: string }) {
  return (await getCommune2026BySyscol(input.syscol)) ?? null;
}
