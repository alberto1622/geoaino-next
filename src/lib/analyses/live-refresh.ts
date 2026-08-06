"use client";

import { useEffect } from "react";

/**
 * live-refresh.ts — notifie les autres onglets qu'une (ou plusieurs) `Analysis`
 * a été modifiée hors de leur page (ex. NICAD reconstruit par
 * `syncNicadForSectionChange` depuis l'onglet `cadastre/sections`), pour que
 * `/map/[analysisId]`, s'il est déjà ouvert, rafraîchisse tuiles + KPI sans
 * rechargement manuel.
 *
 * `BroadcastChannel` : même origine, mêmes onglets/fenêtres du navigateur —
 * pas de serveur de notification, portée volontairement limitée à cet usage
 * (un·e même admin avec deux onglets ouverts), pas un mécanisme multi-utilisateur.
 */
const CHANNEL_NAME = "geoaino-analysis-updates";

export function notifyAnalysesUpdated(analysisIds: number[]): void {
  if (typeof BroadcastChannel === "undefined" || analysisIds.length === 0) return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ analysisIds });
  channel.close();
}

/** S'abonne aux notifications concernant `analysisId` ; `onUpdate` est rappelé à chaque réception. */
export function useAnalysisUpdateListener(analysisId: number, onUpdate: () => void): void {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<{ analysisIds?: number[] }>) => {
      if (event.data?.analysisIds?.includes(analysisId)) onUpdate();
    };
    return () => channel.close();
  }, [analysisId, onUpdate]);
}
