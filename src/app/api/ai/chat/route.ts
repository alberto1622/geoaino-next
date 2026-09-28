import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { invokeLLM, LLMIndisponibleError } from "@/lib/llm";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";
import { rateLimit } from "@/lib/rate-limit";

/** Appels LLM par utilisateur et par fenêtre (coût facturé à chaque appel). */
const CHAT_LIMIT = 30;
const CHAT_WINDOW_MS = 10 * 60 * 1000;
/** Seuls les derniers échanges sont renvoyés au LLM (borne la taille du prompt). */
const MAX_HISTORY_SENT = 40;

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  analysisId: z.number().int().positive().optional(),
  parcelleContext: z
    .object({
      nicad: z.union([z.string().max(100), z.number()]).nullish(),
      surface: z.number().finite().nullish(),
      errors: z.array(z.string().max(200)).max(50).nullish(),
      // Attributs libres de la parcelle : bornés en taille une fois sérialisés.
      properties: z
        .record(z.string(), z.unknown())
        .nullish()
        .refine((p) => p == null || JSON.stringify(p).length <= 10_000, "Propriétés trop volumineuses"),
    })
    .nullish(),
  // Rôle `system` exclu : le client ne doit pas pouvoir réécrire les consignes.
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20_000),
      }),
    )
    .max(200)
    .optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const rl = rateLimit(`ai-chat:${userId}`, CHAT_LIMIT, CHAT_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Trop de requêtes à l'assistant IA, réessayez plus tard." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
  }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  }
  const { message, analysisId, parcelleContext, conversationHistory } = parsed.data;

  let analysisContext = "";

  if (analysisId) {
    const analysis = await prisma.analysis.findUnique({
      where: { id: analysisId },
    });

    if (analysis) {
      const errors = await prisma.topologicalError.findMany({
        where: { analysisId },
      });

      const statsByType: Record<string, number> = {};
      const statsBySeverity: Record<string, number> = {};
      for (const e of errors) {
        statsByType[e.errorType] = (statsByType[e.errorType] || 0) + 1;
        statsBySeverity[e.severity] = (statsBySeverity[e.severity] || 0) + 1;
      }

      const totalParcels = analysis.totalFeatures || 1;
      analysisContext = `
CONTEXTE DE L'ANALYSE:
- Fichier: ${analysis.fileName}
- Format: ${analysis.fileFormat}
- Total parcelles: ${totalParcels}
- Total erreurs: ${errors.length}
- Score conformité: ${analysis.conformityScore}%
- Commune: ${analysis.commune || "N/A"}
- Région: ${analysis.region || "N/A"}
- Statut: ${analysis.status}

PAR SÉVÉRITÉ: Critique=${statsBySeverity["CRITICAL"] || 0}, Élevé=${statsBySeverity["HIGH"] || 0}, Moyen=${statsBySeverity["MEDIUM"] || 0}

PAR TYPE: NICAD manquant=${statsByType["MISSING_NICAD"] || 0}, Chevauchements=${statsByType["OVERLAP"] || 0}, Gaps=${statsByType["GAP"] || 0}, Slivers=${statsByType["SLIVER"] || 0}, Doublons=${statsByType["DUPLICATE"] || 0}

DÉTAIL (${Math.min(errors.length, 50)} premières erreurs):
${errors.slice(0, 50).map((e) => `[${e.errorType}|${e.severity}] ${e.nicad1 || "?"} — ${e.description || ""}`).join("\n")}`;

      // Load GeoJSON if context is needed
      const geoKeywords = ["superficie", "surface", "voisin", "parcelle", "nicad", "liste", "combien", "données"];
      const needsGeoData = geoKeywords.some((kw) => message.toLowerCase().includes(kw));

      if (needsGeoData && analysis.geojsonKey) {
        const geoJson = await loadGeoJsonFromKey(analysis.geojsonKey);
        if (geoJson) {
          const parsed = JSON.parse(geoJson);
          const features = (parsed.features || []).slice(0, 100);
          const summary = features.map((f: { properties?: Record<string, unknown> }) => {
            const props = f.properties || {};
            return `NICAD:${props.NICAD || props.nicad || "?"} — ${JSON.stringify(props).slice(0, 100)}`;
          }).join("\n");
          analysisContext += `\n\nDONNÉES GÉOSPATIALES (${features.length} premières parcelles):\n${summary}`;
        }
      }
    }
  }

  let parcelCtx = "";
  if (parcelleContext) {
    parcelCtx = `\nPARCELLE SÉLECTIONNÉE:\n- NICAD: ${parcelleContext.nicad || "N/A"}\n- Surface: ${parcelleContext.surface?.toFixed(2) || "N/A"} m²\n- Erreurs: ${parcelleContext.errors?.join(", ") || "aucune"}\n- Propriétés: ${JSON.stringify(parcelleContext.properties || {})}`;
  }

  const systemPrompt = `Tu es GEO-AINO, un expert géomaticien et cadastral virtuel ultra-compétent. Tu analyses des données cadastrales et fournis des conseils précis basés UNIQUEMENT sur les données fournies. Réponds en Markdown, sois précis et professionnel.

${analysisContext}${parcelCtx}`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...(conversationHistory ?? []).slice(-MAX_HISTORY_SENT),
    { role: "user", content: message },
  ];

  let assistantMessage: string;
  try {
    assistantMessage = await invokeLLM({ messages });
  } catch (err) {
    if (err instanceof LLMIndisponibleError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  if (analysisId) {
    await prisma.aiConversation.createMany({
      data: [
        { analysisId, userId, role: "USER", content: message, context: (parcelleContext ?? undefined) as Prisma.InputJsonValue | undefined },
        { analysisId, userId, role: "ASSISTANT", content: assistantMessage },
      ],
    });
  }

  return NextResponse.json({ message: assistantMessage });
}
