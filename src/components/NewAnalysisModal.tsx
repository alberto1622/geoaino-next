"use client";
import { useEffect } from "react";
import { X, Upload } from "lucide-react";
import NewAnalysisPanel from "@/components/NewAnalysisPanel";

interface NewAnalysisModalProps {
  onClose: () => void;
}

/**
 * Fenêtre modale « Nouvelle analyse » : ouvre le flux d'upload complet
 * (`NewAnalysisPanel`) par-dessus les pages historique et carte, sans quitter
 * le contexte courant. Dès que l'analyse est prête, le panneau navigue vers
 * `/map/[id]` (prop `inModal`), ce qui démonte la modale.
 *
 * Overlay en `z-[1100]` : au-dessus des panneaux flottants de la carte
 * (`z-[1000]`, cf. § 34 bis) ; les sous-modales de mappage passent en
 * `z-[1200]` via `inModal`.
 */
export default function NewAnalysisModal({ onClose }: NewAnalysisModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border p-4">
          <div className="flex items-center gap-2 font-semibold">
            <Upload className="h-4 w-4 text-primary" />
            Nouvelle analyse
          </div>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <NewAnalysisPanel inModal />
        </div>
      </div>
    </div>
  );
}
