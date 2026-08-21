"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "vteam-theme";

interface ThemeState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "system" as ThemePreference,
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: THEME_STORAGE_KEY,
    }
  )
);

/** 计算有效主题：system 时跟随 prefers-color-scheme */
export function getEffectiveTheme(
  preference: ThemePreference,
  systemDark: boolean
): EffectiveTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}
