import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifier } from "@/lib/cadastre/verif/core";
import {
  Borne,
  CrsSource,
  SourceVerif,
  TOLERANCE_PCT_DEFAUT,
  TOLERANCE_PLANCHER_M2_DEFAUT,
} from "@/lib/cadastre/verif/types";

export const runtime = "nodejs";

const CRS_VALIDES: CrsSource[] = ["EPSG:32628", "EPSG:31028"];
const SOURCES_VALIDES: SourceVerif[] = [
  "saisie",
  "fichier",
  "referentiel",
  "pdf-texte",
  "pdf-referentiel",
  "pdf-ocr",
];

/**
 * Valide le corps de la requête. Les bornes viennent du navigateur : elles
 * sont revalidées ici plutôt que reprises telles quelles, le résultat serveur
 * étant celui qui est persisté (et repris par le PV côté client).
 */
function lireBornes(brut: unknown): Borne[] | null {
  if (!Array.isArray(brut)) return null;
  const bornes: Borne[] = [];
  for (const b of brut) {
    if (!b || typeof b !== "object") return null;
    const { pt, x, y } = b as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    bornes.push({
      pt: typeof pt === "string" && pt ? pt.slice(0, 12) : `B${bornes.length + 1}`,
      x,
      y,
    });
  }
  return bornes;
}

/**
 * POST /api/cadastre/verif — enregistre une vérification.
 *
 * Le calcul est **ré-exécuté ici** à partir des bornes reçues : le rapport
 * calculé côté navigateur n'est qu'un aperçu, seul ce résultat-ci fait foi et
 * est persisté (le PV client est ensuite construit à partir du rapport renvoyé).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Session sans identifiant" }, { status: 401 });
  }

  let corps: Record<string, unknown>;
  try {
    corps = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Corps de requête illisible" }, { status: 400 });
  }

  const bornes = lireBornes(corps?.bornes);
  if (!bornes || bornes.length < 3) {
    return NextResponse.json(
      { error: "Il faut au moins 3 bornes valides (pt, x, y)." },
      { status: 400 },
    );
  }
  if (bornes.length > 500) {
    return NextResponse.json(
      { error: "Trop de bornes (maximum 500) : ce n'est pas un contour de parcelle." },
      { status: 400 },
    );
  }

  const crsSource: CrsSource = CRS_VALIDES.includes(corps?.crsSource as CrsSource)
    ? (corps.crsSource as CrsSource)
    : "EPSG:32628";
  const source: SourceVerif = SOURCES_VALIDES.includes(corps?.source as SourceVerif)
    ? (corps.source as SourceVerif)
    : "saisie";
  const nicad: string | null =
    typeof corps?.nicad === "string" && corps.nicad.trim()
      ? corps.nicad.trim().slice(0, 64)
      : null;

  const nombrePositif = (v: unknown, defaut: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : defaut;
  const tolerancePct = nombrePositif(corps?.tolerancePct, TOLERANCE_PCT_DEFAUT);
  const tolerancePlancherM2 = nombrePositif(
    corps?.tolerancePlancherM2,
    TOLERANCE_PLANCHER_M2_DEFAUT,
  );
  const superficieDeclaree =
    typeof corps?.superficieDeclaree === "number" &&
    Number.isFinite(corps.superficieDeclaree) &&
    (corps.superficieDeclaree as number) > 0
      ? (corps.superficieDeclaree as number)
      : undefined;

  const rapport = verifier({
    bornes,
    crsSource,
    superficieDeclaree,
    tolerancePct,
    tolerancePlancherM2,
  });

  try {
    const enregistrement = await prisma.cadVerification.create({
      data: {
        userId,
        nicad,
        crsSource,
        source,
        bornes: rapport.bornes as unknown as object,
        superficieCalculee: rapport.superficieM2,
        superficieDeclaree: superficieDeclaree ?? null,
        perimetreM: rapport.perimetreM,
        tolerancePct,
        tolerancePlancher: tolerancePlancherM2,
        verdict: rapport.verdict,
        anomalies: rapport.anomalies as unknown as object,
      },
    });

    // Géométrie via SQL brut (PostGIS) — même traitement que CadParcelle.geom.
    if (rapport.geometry) {
      await prisma.$executeRaw`
        UPDATE cad_verifications
        SET geom = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(rapport.geometry)}), 4326)
        WHERE id = ${enregistrement.id}`;
    }

    return NextResponse.json({ id: enregistrement.id, rapport }, { status: 201 });
  } catch (e) {
    console.error("Erreur enregistrement de la vérification :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}

/**
 * GET /api/cadastre/verif — historique des vérifications.
 *
 * Historique **partagé** : tout le module cadastre de geoaino-next est un
 * référentiel organisationnel (cf. /api/cadastre/history), donc n'importe quel
 * utilisateur connecté voit toutes les vérifications, pas seulement les siennes.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const brutLimite = Number(params.get("limit"));
  const limite = Number.isFinite(brutLimite)
    ? Math.min(Math.max(brutLimite, 1), 100)
    : 25;
  const brutOffset = Number(params.get("offset"));
  const offset = Number.isFinite(brutOffset) && brutOffset > 0 ? brutOffset : 0;

  try {
    const [total, lignes] = await Promise.all([
      prisma.cadVerification.count(),
      prisma.cadVerification.findMany({
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limite,
        select: {
          id: true,
          nicad: true,
          verdict: true,
          source: true,
          crsSource: true,
          superficieCalculee: true,
          superficieDeclaree: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      }),
    ]);

    return NextResponse.json({
      total,
      offset,
      limit: limite,
      verifications: lignes.map((l) => ({
        ...l,
        superficieCalculee: Number(l.superficieCalculee),
        superficieDeclaree:
          l.superficieDeclaree === null ? null : Number(l.superficieDeclaree),
      })),
    });
  } catch (e) {
    console.error("Erreur historique des vérifications :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}
