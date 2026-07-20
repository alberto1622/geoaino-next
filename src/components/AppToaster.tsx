"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/components/ThemeProvider";

/** Toaster sonner qui suit le thème de l'application (au lieu d'un "dark" figé). */
export function AppToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} richColors position="top-right" />;
}
