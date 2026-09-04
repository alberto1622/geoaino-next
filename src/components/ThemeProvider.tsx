"use client";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "geoaino-theme";

function applyAndPersist(t: Theme) {
  document.documentElement.classList.toggle("light", t === "light");
  document.documentElement.classList.toggle("dark", t === "dark");
  window.localStorage.setItem(STORAGE_KEY, t);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Design system « Graticule » : sombre par défaut. SSR fixé à "dark" — le
  // premier rendu serveur/client concorde, pas de mismatch d'hydratation.
  // Le <script> inline de layout.tsx a déjà posé la bonne classe avant le paint.
  const [theme, setTheme] = useState<Theme>("dark");

  // Single mount-only effect: sync React state with the real preference.
  // No [theme] effect — DOM is managed here and in toggleTheme to avoid
  // the flash that would occur if a [theme] effect fired with the stale state.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    const resolved = stored ?? "dark";
    applyAndPersist(resolved);
    setTheme(resolved);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyAndPersist(next);
    setTheme(next);
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
