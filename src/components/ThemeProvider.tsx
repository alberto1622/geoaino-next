"use client";
import { createContext, useContext, useSyncExternalStore } from "react";

type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "geoaino-theme";

// Préférence stockée dans localStorage, lue via useSyncExternalStore : le
// rendu serveur (et l'hydratation) utilisent "dark", puis React bascule sur la
// valeur réelle sans setState dans un effet.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function getServerSnapshot(): Theme {
  return "dark";
}

function applyAndPersist(t: Theme) {
  document.documentElement.classList.toggle("light", t === "light");
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    window.localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // stockage indisponible (navigation privée) : thème appliqué pour la page
  }
  listeners.forEach((l) => l());
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Design system « Graticule » : sombre par défaut. SSR fixé à "dark" — le
  // premier rendu serveur/client concorde, pas de mismatch d'hydratation.
  // Le <script> inline de layout.tsx a déjà posé la bonne classe avant le paint.
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleTheme = () => {
    applyAndPersist(theme === "dark" ? "light" : "dark");
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
