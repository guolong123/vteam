"use client";
import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { neutral, radius, space, fontSize } from "@/src/theme/tokens";

const MERMAID_THEME_VARIABLES = {
  primaryColor: "#e0ebfe",
  primaryTextColor: "#1e293b",
  primaryBorderColor: "#c7dafe",
  secondaryColor: "#f8fafc",
  tertiaryColor: "#f1f5f9",
  lineColor: "#94a3b8",
  edgeLabelBackground: "#ffffff",
  clusterBkg: "#f8fafc",
  clusterBorder: "#cbd5e1",
  fontSize: "14px",
} as const;

let initialized = false;
function ensureMermaidInitialized() {
  if (initialized) return;
  mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: MERMAID_THEME_VARIABLES, securityLevel: "strict" });
  initialized = true;
}

let seq = 0;
function nextRenderId(): string {
  seq += 1;
  return `mmd-${Date.now().toString(36)}-${seq}`;
}

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const renderIdRef = useRef(nextRenderId());
  useEffect(() => {
    const source = String(code ?? "").trim();
    if (!source) {
      setSvg(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    ensureMermaidInitialized();
    mermaid
      .render(renderIdRef.current, source)
      .then(({ svg: rendered }) => {
        if (cancelled) return;
        setSvg(rendered);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (failed) {
    return (
      <div data-testid="docs-mermaid-fallback" style={{ margin: `${space.md}px 0` }}>
        <p style={{ margin: `0 0 ${space.xs}px`, fontSize: fontSize.xs, color: "#B45309" }}>图渲染失败，显示源码</p>
        <pre style={{ overflowX: "auto", borderRadius: radius.md, backgroundColor: "#0F172A", color: "var(--color-neutral-200)", padding: space.md, fontSize: fontSize.sm, lineHeight: 1.6 }}>
          <code style={{ fontFamily: "ui-monospace, monospace" }}>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div data-testid="docs-mermaid-loading" style={{ margin: `${space.md}px 0`, height: 96, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], color: neutral[400], fontSize: fontSize.sm }}>
        渲染图中…
      </div>
    );
  }
  return (
    <div data-testid="docs-mermaid" style={{ margin: `${space.lg}px 0`, overflowX: "auto", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", padding: space.md }}>
      <div style={{ display: "flex", justifyContent: "center" }} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
