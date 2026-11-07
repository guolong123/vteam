"use client";

/**
 * SearchableSelect：带搜索框的下拉选择（模型目录较长时使用）。
 * 纯受控组件；点击外部/Escape 关闭；选项支持分组前缀（label 自带）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

export interface SearchableOption {
  value: string;
  label: string;
  keywords?: string;
}

export interface SearchableSelectProps {
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  style?: CSSProperties;
  testId?: string;
}

export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  disabled = false,
  style,
  testId,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return options;
    return options.filter((o) => {
      const text = `${o.label} ${o.keywords ?? ""}`.toLowerCase();
      return text.includes(kw);
    });
  }, [options, query]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} style={{ position: "relative", width: "100%", ...style }}>
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderRadius: radius.md,
          border: `1px solid ${open ? "#0D9488" : neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          color: current ? neutral[700] : neutral[400],
          fontSize: fontSize.xs,
          fontFamily: fontFamily.body,
          cursor: disabled ? "default" : "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.label ?? placeholder}
        </span>
        <span aria-hidden style={{ color: neutral[400], fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            zIndex: 60,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            boxShadow: shadow.md,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: space.sm, borderBottom: `1px solid ${neutral[100]}` }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 8px",
                borderRadius: radius.sm,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: neutral[50],
                color: neutral[800],
                fontSize: fontSize.xs,
                fontFamily: fontFamily.body,
                outline: "none",
              }}
            />
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", padding: 4 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: space.sm, fontSize: fontSize.xs, color: neutral[400] }}>没有匹配项</div>
            ) : (
              filtered.map((opt) => {
                const active = opt.value === value;
                return (
                  <button
                    key={opt.value || "__empty__"}
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      borderRadius: radius.sm,
                      backgroundColor: active ? "rgba(13,148,136,0.10)" : "transparent",
                      color: active ? "#0F766E" : neutral[700],
                      padding: "6px 8px",
                      fontSize: fontSize.xs,
                      fontFamily: fontFamily.body,
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
