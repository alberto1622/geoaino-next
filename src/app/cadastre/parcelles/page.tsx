import { PageTitle } from "@/components/PageTitle";
import { prisma } from "@/lib/prisma";
import ParcellesVisualisationClient from "@/components/cadastre/ParcellesVisualisationClient";

export const metadata = { title: "Visualisation des parcelles" };

/**
 * Page « Visualisation des parcelles » (/cadastre/parcelles) : sélection
 * multi-fichiers parmi les Analysis déjà traitées (mêmes fichiers que
 * /history), affichage combiné sur une carte avec erreurs + légende
 * (calqué sur /map/[analysisId], MapAnalysisClient.tsx), mais SANS action de
 * correction — page de consultation, pas d'édition. Export shapefile de la
 * sélection courante.
 *
 * `select` explicite (pas `include`) — mêmes raisons que /history et le
 * correctif § « GET /api/analyses plante » (CONCEPTS-TRAITEMENT-DXF.md) :
 * ne jamais embarquer `geoJsonData`/`correctedData`/`errorsData` dans une
 * liste, le GeoJSON de chaque fichier sélectionné est chargé à part
 * (`/api/analyses/[id]/geojson`) uniquement pour les fichiers cochés.
 */
export default async function ParcellesVisualisationPage() {
  const rows = await prisma.analysis.findMany({
    where: { status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      fileName: true,
      fileFormat: true,
      totalFeatures: true,
      errorCount: true,
      commune: true,
      region: true,
      createdAt: true,
    },
  });

  const files = rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <PageTitle title="Visualisation des parcelles" />
      <ParcellesVisualisationClient files={files} />
    </div>
  );
}
