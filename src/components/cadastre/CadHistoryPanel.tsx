"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface HistoryEntry {
  id: number;
  action: string;
  summary: string;
  restoredAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Panneau "Historique" partagé entre `/cadastre/sections` et `/map` — liste
 * les modifications passées d'un `scope`/`scopeKey` (liste complète, pas
 * seulement la dernière action) et permet de restaurer n'importe laquelle.
 * Composant autonome : gère son propre chargement et sa propre confirmation,
 * ne dépend de l'appelant que via `onRestored`.
 */
export function CadHistoryPanel({
  open,
  onOpenChange,
  scope,
  scopeKey,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "sections" | "map";
  scopeKey: string | null;
  onRestored: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<HistoryEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ scope });
      if (scopeKey) params.set("scopeKey", scopeKey);
      const res = await fetch(`/api/cadastre/history?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chargement de l'historique échoué");
      setEntries(data.entries ?? []);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, scopeKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, load]);

  const performRestore = useCallback(
    async (entry: HistoryEntry) => {
      setRestoringId(entry.id);
      try {
        const res = await fetch(`/api/cadastre/history/${entry.id}/restore`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Restauration échouée");
        toast.success("État restauré.");
        await load();
        onRestored();
      } catch (err) {
        toast.error(String(err));
      } finally {
        setRestoringId(null);
      }
    },
    [load, onRestored],
  );

  const mostRecentId = entries[0]?.id ?? null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" title="Historique des modifications" className="w-full max-w-md">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Aucune modification enregistrée.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-lg border border-border/60 p-3 text-sm">
                  <p className="font-medium leading-snug">{e.summary}</p>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {new Date(e.createdAt).toLocaleString("fr-FR")}
                      {e.restoredAt ? " · restauré depuis" : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 gap-1 px-2 text-xs"
                      disabled={restoringId === e.id}
                      onClick={() => setConfirmEntry(e)}
                    >
                      {restoringId === e.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      Restaurer
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmEntry !== null}
        title="Restaurer cet état"
        description={
          confirmEntry
            ? confirmEntry.summary +
              (confirmEntry.id !== mostRecentId
                ? "\n\nDes actions plus récentes existent après ce point — les restaurer écrasera l'état actuel."
                : "")
            : ""
        }
        confirmLabel="Restaurer"
        onConfirm={() => {
          if (confirmEntry) void performRestore(confirmEntry);
          setConfirmEntry(null);
        }}
        onCancel={() => setConfirmEntry(null)}
      />
    </>
  );
}
