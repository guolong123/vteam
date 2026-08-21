"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parsePrdMarkdown } from "./parser";
import { MermaidBlock } from "./mermaid-block";
import { PrototypeEmbed } from "./prototype-embed";
import type { PrototypeListItem } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* 品牌蓝（对齐 roleText.product / ui-markdown 链接色，双主题下保持可读） */
const ACCENT = "#2563EB";
const ACCENT_BG = "rgba(37,99,235,0.10)";
const ACCENT_BORDER = "rgba(37,99,235,0.22)";

function textOf(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function headingId(text: string): string {
  return text.replace(/[`*_#[]()]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").toLowerCase();
}

interface DocsMarkdownProps {
  markdown: string;
  prototypes?: PrototypeListItem[];
  taskId?: string;
}

export function DocsMarkdown({ markdown, prototypes = [], taskId }: DocsMarkdownProps) {
  const parsed = useMemo(() => parsePrdMarkdown(markdown), [markdown]);
  const components = useMemo(
    () =>
      ({
        h1: ({ children }: any) => (
          <h1
            id="prd-title"
            style={{
              margin: `${space.xxl}px 0 ${space.md}px`,
              paddingBottom: space.sm,
              borderBottom: `1px solid ${border}`,
              fontSize: fontSize.xxl,
              fontWeight: 600,
              color: neutral[900],
              lineHeight: 1.4,
              ...baseFont,
            }}
          >
            {children}
          </h1>
        ),
        h2: ({ children }: any) => (
          <h2
            id={headingId(textOf(children))}
            style={{
              margin: `${space.xl}px 0 ${space.sm}px`,
              scrollMarginTop: 96,
              fontSize: fontSize.xl,
              fontWeight: 600,
              color: neutral[900],
              lineHeight: 1.4,
              ...baseFont,
            }}
          >
            {children}
          </h2>
        ),
        h3: ({ children }: any) => (
          <h3
            id={headingId(textOf(children))}
            style={{
              margin: `${space.lg}px 0 ${space.xs}px`,
              scrollMarginTop: 96,
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              lineHeight: 1.4,
              ...baseFont,
            }}
          >
            {children}
          </h3>
        ),
        p: ({ children }: any) => (
          <p style={{ margin: `${space.sm}px 0`, lineHeight: 1.7, color: neutral[700], ...baseFont }}>{children}</p>
        ),
        ul: ({ children }: any) => (
          <ul style={{ margin: `${space.sm}px 0`, paddingLeft: 24, listStyle: "disc", color: neutral[700], ...baseFont }}>{children}</ul>
        ),
        ol: ({ children }: any) => (
          <ol style={{ margin: `${space.sm}px 0`, paddingLeft: 24, listStyle: "decimal", color: neutral[700], ...baseFont }}>{children}</ol>
        ),
        li: ({ children }: any) => <li style={{ margin: `${space.xs}px 0`, lineHeight: 1.7 }}>{children}</li>,
        a: ({ href, children }: any) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            style={{ color: ACCENT, textDecoration: "underline", textUnderlineOffset: 2, textDecorationColor: "rgba(37,99,235,0.35)" }}
          >
            {children}
          </a>
        ),
        strong: ({ children }: any) => <strong style={{ fontWeight: 600, color: neutral[900] }}>{children}</strong>,
        em: ({ children }: any) => <em style={{ fontStyle: "italic" }}>{children}</em>,
        del: ({ children }: any) => <del style={{ color: neutral[400] }}>{children}</del>,
        code: ({ className, children }: any) => {
          const isBlock = typeof className === "string" && className.includes("language-");
          if (isBlock) {
            // 块级代码：背景/边框由 pre 容器提供，此处仅保留等宽字体
            return <code style={{ fontFamily: fontFamily.mono, fontSize: "0.9em", color: "inherit", background: "transparent", padding: 0 }}>{children}</code>;
          }
          return (
            <code
              style={{
                fontFamily: fontFamily.mono,
                fontSize: "0.85em",
                backgroundColor: neutral[100],
                borderRadius: radius.sm,
                padding: "2px 6px",
                color: neutral[800],
              }}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }: any) => {
          const codeChild = Array.isArray(children) ? children[0] : children;
          const className = codeChild != null && typeof codeChild === "object" && "props" in codeChild ? (codeChild as { props?: { className?: unknown } }).props?.className : undefined;
          if (typeof className === "string" && className.includes("language-mermaid")) {
            const source = textOf((codeChild as { props: { children?: ReactNode } }).props?.children);
            return <MermaidBlock code={source} />;
          }
          const lang = typeof className === "string" ? className.replace(/^language-/, "") : "";
          return (
            <div
              style={{
                margin: `${space.md}px 0`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                overflow: "hidden",
                backgroundColor: neutral[100],
              }}
            >
              {lang && (
                <div
                  style={{
                    padding: `${space.xs}px ${space.md}px`,
                    borderBottom: `1px solid ${neutral[200]}`,
                    backgroundColor: neutral[50],
                    fontSize: fontSize.xs,
                    fontWeight: 600,
                    color: neutral[500],
                    fontFamily: fontFamily.mono,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {lang}
                </div>
              )}
              <pre
                style={{
                  margin: 0,
                  padding: space.md,
                  overflowX: "auto",
                  fontSize: fontSize.sm,
                  lineHeight: 1.6,
                  color: neutral[800],
                  fontFamily: fontFamily.mono,
                }}
              >
                {children}
              </pre>
            </div>
          );
        },
        blockquote: ({ children }: any) => (
          <blockquote
            style={{
              margin: `${space.md}px 0`,
              padding: `${space.sm}px ${space.lg}px`,
              borderLeft: `3px solid ${neutral[300]}`,
              backgroundColor: neutral[50],
              borderRadius: `0 ${radius.sm}px ${radius.sm}px 0`,
              color: neutral[600],
              fontSize: fontSize.md,
              ...baseFont,
            }}
          >
            {children}
          </blockquote>
        ),
        hr: () => <hr style={{ margin: `${space.xl}px 0`, border: "none", borderTop: `1px solid ${border}` }} />,
        table: ({ children }: any) => (
          <div style={{ margin: `${space.md}px 0`, overflowX: "auto", borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: fontSize.md, ...baseFont }}>{children}</table>
          </div>
        ),
        thead: ({ children }: any) => <thead style={{ backgroundColor: neutral[50] }}>{children}</thead>,
        th: ({ children }: any) => (
          <th
            style={{
              padding: `${space.sm}px ${space.md}px`,
              borderBottom: `1px solid ${neutral[200]}`,
              textAlign: "left",
              fontWeight: 600,
              color: neutral[700],
              whiteSpace: "nowrap",
            }}
          >
            {children}
          </th>
        ),
        td: ({ children }: any) => (
          <td style={{ padding: `${space.sm}px ${space.md}px`, borderBottom: `1px solid ${neutral[100]}`, color: neutral[700], verticalAlign: "top" }}>
            {children}
          </td>
        ),
        img: ({ src, alt }: any) => (
          // eslint-disable-next-line @next/next/no-img-element -- markdown 内任意图片 URL，无法走 next/image 优化
          <img src={src} alt={alt ?? ""} style={{ maxWidth: "100%", borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
        ),
        input: ({ checked }: any) => (
          <input type="checkbox" checked={!!checked} readOnly style={{ marginRight: space.sm, accentColor: ACCENT, verticalAlign: "middle" }} />
        ),
        div: (props: Record<string, unknown>) => {
          const { children, ...rest } = props as { children?: ReactNode } & Record<string, unknown>;
          const p = rest as Record<string, unknown>;
          const proto = p["data-proto"] as string | undefined;
          if (proto) {
            const ph = String(p["data-ph"] ?? "");
            if (proto === "embed") {
              const spec = parsed.embeds.get(ph);
              if (!spec || !taskId) return null;
              return <PrototypeEmbed spec={spec} prototypes={prototypes} taskId={taskId} />;
            }
            if (proto === "list") {
              const ids = [...parsed.embeds.values()].map((e) => e.id);
              const unique = [...new Set(ids)];
              return (
                <div style={{ margin: `${space.md}px 0`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: surface, padding: space.md, ...baseFont }}>
                  <p style={{ margin: `0 0 ${space.sm}px`, fontSize: fontSize.xs, fontWeight: 600, color: neutral[500] }}>本文档引用原型（{unique.length}）</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: space.sm }}>
                    {unique.map((id) => (
                      <a
                        key={id}
                        href={`?proto=${id}`}
                        style={{ borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, padding: `${space.xs}px ${space.sm + 2}px`, fontSize: fontSize.xs, color: neutral[600], textDecoration: "none" }}
                      >
                        {id}
                      </a>
                    ))}
                  </div>
                </div>
              );
            }
          }
          return <div {...(rest as Record<string, unknown>)}>{children as ReactNode}</div>;
        },
        span: (props: Record<string, unknown>) => {
          const p = props as Record<string, unknown>;
          const proto = p["data-proto"] as string | undefined;
          if (proto === "inline") {
            const ph = String(p["data-ph"] ?? "");
            const id = parsed.inlineRefs.get(ph);
            if (!id) return null;
            const hit = prototypes.find((pr) => pr.id === id || pr.metaId === id);
            const label = hit?.name ?? id;
            if (!hit) {
              return (
                <span
                  style={{ margin: `0 ${space.xs}px`, display: "inline-flex", alignItems: "center", borderRadius: radius.sm, border: "1px solid #FDE68A", backgroundColor: "#FFFBEB", padding: "2px 6px", fontSize: fontSize.xs, color: "#B45309", fontFamily: fontFamily.body }}
                >
                  原型 {id} 未找到
                </span>
              );
            }
            return (
              <a
                href={`?proto=${id}`}
                style={{ margin: "0 2px", display: "inline-flex", alignItems: "center", gap: 4, borderRadius: radius.sm, backgroundColor: ACCENT_BG, padding: "2px 6px", fontSize: fontSize.xs, fontWeight: 500, color: ACCENT, textDecoration: "none", boxShadow: `inset 0 0 0 1px ${ACCENT_BORDER}` }}
              >
                原型「{label}」↗
              </a>
            );
          }
          const { children, ...rest } = props as { children?: ReactNode } & Record<string, unknown>;
          return <span {...(rest as Record<string, unknown>)}>{children as ReactNode}</span>;
        },
      }) as unknown as Components,
    [parsed, prototypes]
  );

  const remarkPlugins = useMemo(() => {
    const plugin = () => (tree: unknown) => {
      const INLINE_RE = /@@PROTO_INLINE_[^\s]+/g;
      const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (n["type"] === "paragraph" && Array.isArray(n["children"]) && (n["children"] as unknown[]).length === 1) {
          const child = (n["children"] as Record<string, unknown>[])[0];
          if (child?.["type"] === "text") {
            const text = String(child["value"] ?? "");
            const trimmed = text.trim();
            if (parsed.embeds.has(trimmed)) { n["type"] = "prototype"; (n as Record<string, unknown>)["data"] = { placeholder: trimmed }; n["children"] = []; return; }
            if (parsed.lists.has(trimmed)) { n["type"] = "prototype-list"; (n as Record<string, unknown>)["data"] = { placeholder: trimmed }; n["children"] = []; return; }
          }
        }
        if (Array.isArray(n["children"])) {
          const children = n["children"] as unknown[];
          const next: unknown[] = [];
          for (const c of children) {
            const cn = c as Record<string, unknown>;
            if (cn?.["type"] === "text") {
              const text = String(cn["value"] ?? "");
              let last = 0;
              let m: RegExpExecArray | null;
              let hasInline = false;
              INLINE_RE.lastIndex = 0;
              while ((m = INLINE_RE.exec(text)) !== null) {
                const ph = m[0];
                if (!parsed.inlineRefs.has(ph)) continue;
                hasInline = true;
                if (m.index > last) next.push({ type: "text", value: text.slice(last, m.index) });
                next.push({ type: "prototype-inline", data: { placeholder: ph }, children: [] });
                last = m.index + ph.length;
              }
              if (hasInline) {
                if (last < text.length) next.push({ type: "text", value: text.slice(last) });
                continue;
              }
            }
            visit(c);
            next.push(c);
          }
          if (next.length !== children.length || next.some((v, i) => v !== children[i])) {
            n["children"] = next;
          }
        }
      };
      visit(tree);
    };
    return [plugin, remarkGfm] as unknown[];
  }, [parsed]);

  const remarkRehypeOptions = useMemo(() => ({ unknownHandler: (_state: unknown, node: unknown) => {
    const n = node as Record<string, unknown>;
    const data = n["data"] as Record<string, unknown> | undefined;
    const ph = String(data?.["placeholder"] ?? "");
    const t = String(n["type"] ?? "");
    if (t === "prototype-inline") {
      return { type: "element", tagName: "span", properties: { "data-proto": "inline", "data-ph": ph }, children: [] };
    }
    return { type: "element", tagName: "div", properties: { "data-proto": t === "prototype-list" ? "list" : "embed", "data-ph": ph }, children: [] };
  } } as unknown as Record<string, unknown>), []);

  return <ReactMarkdown remarkPlugins={remarkPlugins as never} remarkRehypeOptions={remarkRehypeOptions} components={components}>{parsed.markdown}</ReactMarkdown>;
}