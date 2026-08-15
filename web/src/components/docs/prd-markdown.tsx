"use client";

/**
 * DocsMarkdown：文档正文渲染（is_0000000024 v4，移植自 prototype-viewer PrdMarkdown，简化）
 * =============================================================
 * - react-markdown + remark-gfm（表格/列表/链接/代码块）；
 * - ```mermaid 代码块 → MermaidBlock 渲染为图；
 * - h2/h3 带锚点 id（与 DocExplorer 章节菜单 scrollIntoView 对齐）；
 * - 样式与 web Markdown（is_0000000019）视觉对齐，宽表格横向滚动。
 */
import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { neutral, radius, space, fontSize } from "@/src/theme/tokens";
import { MermaidBlock } from "./mermaid-block";

/** 从 ReactNode 提取纯文本（标题锚点 id 用）。 */
function textOf(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/** 章节文本 → 稳定锚点 id（对齐 prototype-viewer headingId）。 */
function headingId(text: string): string {
  return text
    .replace(/[`*_#[]()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export function DocsMarkdown({ markdown }: { markdown: string }) {
  const components = useMemo<Components>(
    () => ({
      h1: ({ children }) => (
        <h1
          id="docs-title"
          style={{
            margin: `${space.lg}px 0 ${space.md}px`,
            paddingBottom: space.sm,
            borderBottom: `1px solid ${neutral[200]}`,
            fontSize: 20,
            fontWeight: 600,
            color: neutral[900],
          }}
        >
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2
          id={headingId(textOf(children))}
          style={{ margin: `${space.lg}px 0 ${space.sm}px`, fontSize: 17, fontWeight: 600, color: neutral[900], scrollMarginTop: 96 }}
        >
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3
          id={headingId(textOf(children))}
          style={{ margin: `${space.md}px 0 ${space.xs}px`, fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], scrollMarginTop: 96 }}
        >
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 style={{ margin: `${space.md}px 0 ${space.xs}px`, fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>
          {children}
        </h4>
      ),
      p: ({ children }) => <p style={{ margin: `${space.sm}px 0`, lineHeight: 1.7, color: neutral[700] }}>{children}</p>,
      ul: ({ children }) => (
        <ul style={{ margin: `${space.sm}px 0`, paddingLeft: 24, listStyle: "disc", color: neutral[700] }}>{children}</ul>
      ),
      ol: ({ children }) => (
        <ol style={{ margin: `${space.sm}px 0`, paddingLeft: 24, listStyle: "decimal", color: neutral[700] }}>{children}</ol>
      ),
      li: ({ children }) => <li style={{ lineHeight: 1.7 }}>{children}</li>,
      table: ({ children }) => (
        <div style={{ margin: `${space.md}px 0`, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: fontSize.md }}>{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th
          style={{
            border: `1px solid ${neutral[300]}`,
            backgroundColor: neutral[50],
            padding: `${space.sm}px ${space.md}px`,
            textAlign: "left",
            fontWeight: 600,
            color: neutral[700],
          }}
        >
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td style={{ border: `1px solid ${neutral[300]}`, padding: `${space.sm}px ${space.md}px`, color: neutral[700] }}>
          {children}
        </td>
      ),
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer" style={{ color: "#2563EB", textDecoration: "underline" }}>
          {children}
        </a>
      ),
      code: ({ className, children }) => (
        <code
          className={className}
          style={{
            backgroundColor: neutral[100],
            borderRadius: 4,
            padding: "1px 5px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "0.88em",
            color: neutral[800],
          }}
        >
          {children}
        </code>
      ),
      pre: ({ children }) => {
        const codeChild = Array.isArray(children) ? children[0] : children;
        const className =
          codeChild != null && typeof codeChild === "object" && "props" in codeChild
            ? (codeChild as { props?: { className?: unknown } }).props?.className
            : undefined;
        if (typeof className === "string" && className.includes("language-mermaid")) {
          const source = textOf((codeChild as { props: { children?: ReactNode } }).props?.children);
          return <MermaidBlock code={source} />;
        }
        return (
          <pre
            style={{
              margin: `${space.md}px 0`,
              overflowX: "auto",
              borderRadius: radius.md,
              backgroundColor: "#0F172A",
              color: "#E2E8F0",
              padding: space.md,
              fontSize: fontSize.sm,
              lineHeight: 1.6,
            }}
          >
            {children}
          </pre>
        );
      },
      blockquote: ({ children }) => (
        <blockquote
          style={{
            margin: `${space.md}px 0`,
            borderLeft: "3px solid #BFDBFE",
            backgroundColor: "#EFF6FF",
            padding: `${space.sm}px ${space.md}px`,
            color: neutral[600],
          }}
        >
          {children}
        </blockquote>
      ),
      hr: () => <hr style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, margin: `${space.lg}px 0` }} />,
    }),
    [],
  );

  return (
    <div data-testid="docs-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
