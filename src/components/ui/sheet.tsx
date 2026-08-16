"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Panneau latéral (drawer) construit sur Radix Dialog — utilisé pour la
 * navigation mobile (NavBar, sidebar Cadastre).
 */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({
  side = "left",
  title,
  className,
  children,
}: {
  side?: "left" | "right";
  /** Titre accessible (annoncé aux lecteurs d'écran, affiché en tête du panneau). */
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      {/* z-[1100] : au-dessus des panneaux flottants de la carte (Chevauchements,
          sélection de fusion…) qui montent volontairement à z-1000 pour
          dominer les contrôles Leaflet internes (z-index 1000 par défaut) —
          un Sheet reste un overlay modal, il doit toujours passer au-dessus. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-[1100] bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-0 z-[1100] flex h-full w-72 flex-col overflow-y-auto border-border bg-card p-4 shadow-xl",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
          className,
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <DialogPrimitive.Title className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Fermer le menu"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent };
