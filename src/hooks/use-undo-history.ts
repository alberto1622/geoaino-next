"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Pile annuler/rétablir générique, en mémoire (perdue au rechargement de page —
 * comportement voulu, l'historique ne vit que le temps de la session). Ne
 * connaît rien du réseau : chaque appelant pousse ses propres entrées et
 * applique lui-même l'effet (appel serveur + mise à jour locale) au moment
 * d'annuler/rétablir.
 */
export function useUndoHistory<T>() {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);

  const push = useCallback((entry: T) => {
    setPast((prev) => [...prev, entry]);
    setFuture([]); // une nouvelle action invalide la pile de rétablissement
  }, []);

  // Retire et retourne la dernière entrée annulable ; l'appelant l'applique
  // puis la reporte lui-même vers `future` (via `commitUndo`) une fois l'appel
  // serveur réussi — on ne déplace rien tant que l'effet n'a pas abouti.
  const peekUndo = useCallback((): T | undefined => past[past.length - 1], [past]);
  const peekRedo = useCallback((): T | undefined => future[future.length - 1], [future]);

  // `replacement` : certaines actions changent d'identité en s'annulant (ex.
  // une section supprimée reprend un NOUVEL id en étant ré-insérée) — l'entrée
  // reportée dans l'autre pile doit alors porter cette identité à jour pour
  // qu'un futur rétablir/annuler cible la bonne ressource.
  const commitUndo = useCallback((replacement?: T) => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const entry = prev[prev.length - 1];
      setFuture((f) => [...f, replacement !== undefined ? replacement : entry]);
      return prev.slice(0, -1);
    });
  }, []);

  const commitRedo = useCallback((replacement?: T) => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const entry = prev[prev.length - 1];
      setPast((p) => [...p, replacement !== undefined ? replacement : entry]);
      return prev.slice(0, -1);
    });
  }, []);

  const clear = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    push,
    peekUndo,
    peekRedo,
    commitUndo,
    commitRedo,
    clear,
  };
}

/**
 * Ctrl+Z / Ctrl+Y (et Ctrl+Maj+Z) déclenchent `onUndo`/`onRedo`, sauf quand le
 * focus est dans un champ de saisie (input/textarea/contenteditable) — le
 * navigateur garde alors la main sur l'annulation de la frappe en cours,
 * comme dans Word.
 */
export function useUndoRedoShortcuts(onUndo: () => void, onRedo: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        onUndo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        onRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onUndo, onRedo]);
}
