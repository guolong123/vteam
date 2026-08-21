"use client";

import { useEffect, useRef, useState } from "react";
import { useThemeStore, type ThemePreference } from "./theme-store";
import { neutral, radius, fontSize, fontFamily } from "./tokens";

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "浅色", icon: "☀" },
  { value: "dark", label: "深色", icon: "☾" },
  { value: "system", label: "跟随系统", icon: "◐" },
];

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        data-testid="theme-toggle"
        aria-label="切换主题"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          color: neutral[700],
          fontSize: fontSize.sm,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: fontFamily.body,
          whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
          {current.icon}
        </span>
        {current.label}
        <span aria-hidden style={{ fontSize: 10, opacity: 0.6 }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="theme-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 140,
            padding: 4,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: "0 8px 24px rgba(15,23,42,.12), 0 2px 6px rgba(15,23,42,.08)",
            zIndex: 100,
          }}
        >
          {OPTIONS.map((opt) => {
            const active = opt.value === theme;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-testid={`theme-option-${opt.value}`}
                onClick={() => {
                  setTheme(opt.value);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: radius.sm,
                  border: "none",
                  backgroundColor: active ? "rgba(59,130,246,.10)" : "transparent",
                  color: active ? "#2563EB" : neutral[700],
                  fontSize: fontSize.sm,
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                  textAlign: "left",
                }}
              >
                <span aria-hidden style={{ width: 16, textAlign: "center" }}>
                  {opt.icon}
                </span>
                {opt.label}
                {active && (
                  <span aria-hidden style={{ marginLeft: "auto", fontSize: 12 }}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
