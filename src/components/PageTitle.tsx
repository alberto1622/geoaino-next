"use client";

import { useEffect } from "react";

/**
 * Titre d'onglet pour les pages entièrement client (« use client »), qui ne
 * peuvent pas exporter `metadata`. Les pages serveur utilisent `metadata`
 * (gabarit « %s — GéoAino » du layout racine).
 */
export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = `${title} — GéoAino`;
  }, [title]);
  return null;
}
