"use server";

import {
  countNicads,
  countNicadsBascules,
  countCommunes2013,
  countCommunes2026,
  countHistorique,
  countOperations,
  countSections,
  countParcelles,
  getRecentOperations,
} from "@/lib/cadastre/data";

export async function getDashboardStats() {
  const [
    totalNicads,
    nicads2013,
    nicads2026,
    bascules,
    totalHistorique,
    totalCommunes2013,
    totalCommunes2026,
    totalOperations,
    recentOps,
    totalParcelles,
    totalSections,
  ] = await Promise.all([
    countNicads(),
    countNicads("2013"),
    countNicads("2026"),
    countNicadsBascules(),
    countHistorique(),
    countCommunes2013(),
    countCommunes2026(),
    countOperations(),
    getRecentOperations(5),
    countParcelles(),
    countSections(),
  ]);

  return {
    nicads: {
      total: totalNicads,
      version2013: nicads2013,
      version2026: nicads2026,
      bascules,
      tauxBasculement: totalNicads > 0 ? Math.round((bascules / totalNicads) * 100) : 0,
    },
    communes: { total2013: totalCommunes2013, total2026: totalCommunes2026 },
    historique: { total: totalHistorique },
    operations: { total: totalOperations, recentes: recentOps },
    parcelles: { total: totalParcelles, sections: totalSections },
  };
}

export async function getRecentOperationsList(input?: { limit?: number }) {
  return getRecentOperations(input?.limit ?? 20);
}
