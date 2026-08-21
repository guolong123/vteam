"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useThemeStore, getEffectiveTheme } from "./theme-store";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // 标记已水合，避免 SSR 与客户端不一致
    if (useThemeStore.persist.hasHydrated()) {
      setHydrated(true);
    } else {
      const unsub = useThemeStore.persist.onFinishHydration(() => setHydrated(true));
      return unsub;
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const effective = getEffectiveTheme(theme, mql.matches);
      const root = document.documentElement;
      root.classList.toggle("dark", effective === "dark");
      root.setAttribute("data-theme", effective);
      // 供浏览器原生控件（滚动条/表单）跟随
      root.style.colorScheme = effective;
    };

    apply();

    // system 模式下监听系统变化
    const handler = () => {
      if (theme === "system") apply();
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [theme, hydrated]);

  return <>{children}</>;
}
