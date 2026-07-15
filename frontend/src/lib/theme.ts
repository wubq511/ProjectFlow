"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "projectflow-theme";

type Theme = "light" | "dark" | "system";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.classList.toggle("dark", resolved === "dark");
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // ignore storage errors
  }
  return "system";
}

function setStoredTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore storage errors
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(getStoredTheme());
    media.addEventListener("change", handler);

    const storageHandler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = (e.newValue as Theme) ?? "system";
        setThemeState(next);
        applyTheme(next);
      }
    };
    window.addEventListener("storage", storageHandler);

    return () => {
      media.removeEventListener("change", handler);
      window.removeEventListener("storage", storageHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setStoredTheme(next);
    applyTheme(next);
  }, []);

  const resolved =
    theme === "system"
      ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  return { theme, setTheme, resolved };
}
