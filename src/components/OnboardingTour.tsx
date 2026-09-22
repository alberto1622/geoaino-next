"use client";

import { useEffect, useMemo } from "react";
import { Joyride, STATUS, type EventData, type Step } from "react-joyride";
import { getOnboardingStatus, marquerOnboardingVu } from "@/app/_actions/onboarding";

interface OnboardingTourProps {
  role?: string | null;
  run: boolean;
  setRun: (run: boolean) => void;
}

export function OnboardingTour({ role, run, setRun }: OnboardingTourProps) {
  // Vérifie une seule fois, au montage, si l'utilisateur a déjà vu le
  // guide — lance automatiquement le tour si non. Échec (session expirée,
  // réseau) volontairement ignoré : pas de blocage, l'utilisateur garde
  // le bouton « Aide » pour le lancer manuellement.
  useEffect(() => {
    let cancelled = false;
    getOnboardingStatus()
      .then(({ vu }) => {
        if (!cancelled && !vu) setRun(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = useMemo<Step[]>(() => {
    const base: Step[] = [
      {
        target: "body",
        placement: "center",
        title: "Bienvenue sur GéoAino",
        content:
          "Détection des erreurs topologiques, correction et rapports d'analyse des données cadastrales du Sénégal. Ce guide vous présente rapidement les grandes zones de l'application.",
        skipBeacon: true,
      },
      {
        target: '[data-tour="nav-dashboard"]',
        content: "Le tableau de bord : vue d'ensemble de vos imports et analyses.",
      },
      {
        target: '[data-tour="nav-cadastre"]',
        content:
          "Le module Cadastre : basculement NICAD 2013 → 2026, migration en masse, gestion des sections, import DXF/shapefile.",
      },
      {
        target: '[data-tour="nav-history"]',
        content: "L'historique : la traçabilité de toutes les actions effectuées.",
      },
      {
        target: '[data-tour="nav-reports"]',
        content: "Les rapports : consultation et export des résultats d'analyse.",
      },
    ];
    if (role === "ADMIN") {
      base.push({
        target: '[data-tour="nav-admin-users"]',
        content: "Gestion des utilisateurs et de leurs rôles.",
      });
    }
    base.push({
      target: '[data-tour="nav-aide"]',
      content: "Vous pouvez revoir ce guide à tout moment ici.",
    });
    return base;
  }, [role]);

  function handleCallback(data: EventData) {
    const { status } = data;
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      setRun(false);
      // Échec sans conséquence grave : le tour se relancera simplement à
      // la prochaine connexion si l'écriture n'a pas abouti.
      marquerOnboardingVu().catch(() => {});
    }
  }

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      scrollToFirstStep
      onEvent={handleCallback}
      options={{
        arrowColor: "var(--card)",
        backgroundColor: "var(--card)",
        overlayColor: "rgba(0, 0, 0, 0.5)",
        primaryColor: "var(--primary)",
        textColor: "var(--card-foreground)",
        zIndex: 10000,
        showProgress: true,
        buttons: ["back", "close", "primary", "skip"],
      }}
      locale={{
        back: "Précédent",
        close: "Fermer",
        last: "Terminer",
        next: "Suivant",
        nextWithProgress: "Suivant (étape {current} sur {total})",
        open: "Ouvrir le guide",
        skip: "Passer",
      }}
    />
  );
}
