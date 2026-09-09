import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { STORAGE_KEYS } from "../app_constants";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

export const readThemePreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_THEME);
    if (stored === "dark" || stored === "light" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage unavailable
  }
  return "light";
};

export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme => {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
};

/**
 * Same storage and `<html class="dark">` contract as the editor's
 * `useHandleAppTheme` / `index.html`, so switching here carries over.
 */
export const useDashboardTheme = () => {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(readThemePreference);
  const [systemDark, setSystemDark] = useState(() => !!darkQuery()?.matches);

  useEffect(() => {
    const query = darkQuery();
    if (!query) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme = resolveTheme(preference, systemDark);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_THEME, next);
    } catch {
      // ignore
    }
    setPreferenceState(next);
  }, []);

  return { preference, theme, setPreference };
};
