import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { invokeLLM } from "@/lib/llm";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";

export async function POST(req: NextRequest) {
  const session = await auth();
  const body = await req.json();
  const { message, analysisId, parcelleContext, conversationHistory } = body;

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
    ...(conversationHistory || []).map((m: { role: "user" | "assistant"; content: string }) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: message },
  ];

  const assistantMessage = await invokeLLM({ messages });

  if (session?.user?.id && analysisId) {
    await prisma.aiConversation.createMany({
      data: [
        { analysisId, userId: session.user.id, role: "USER", content: message, context: parcelleContext ?? null },
        { analysisId, userId: session.user.id, role: "ASSISTANT", content: assistantMessage },
      ],
    });
  }

  return NextResponse.json({ message: assistantMessage });
}
