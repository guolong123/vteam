import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ParsedPrd } from "./parser";
import PrototypeEmbed from "../components/PrototypeEmbed";
import MermaidBlock from "../components/MermaidBlock";

/** 从 ReactNode 提取纯文本（用于生成标题锚点 id） */
function textOf(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/**
 * PrdMarkdown：渲染解析后的 PRD markdown
 * =====================================================
 * 占位符行（@@PROTO_EMBED_x 等）通过 remark 插件转换为名为
 * "prototype"/"prototype-list"/"prototype-inline" 的 mdast 节点，
 * 再由 react-markdown 的 components 映射为原型组件 / 清单 / 引用。
 */

/** remark 插件：将占位符行转换为自定义 mdast 节点（embeds/lists 为独立段落，inline 可能位于 code span 内） */
function placeholderPlugin(parsed: ParsedPrd) {
  return () => (tree: unknown) => {
    const walk = (node: any) => {
      if (node.type === "paragraph" && node.children?.length === 1) {
        const child = node.children[0];
        if (child?.type === "text") {
          const text = child.value as string;
          if (parsed.embeds.has(text)) {
            node.type = "prototype";
            node.data = { placeholder: text };
            node.children = [];
            return;
          }
          if (parsed.lists.has(text)) {
            node.type = "prototype-list";
            node.data = { placeholder: text };
            node.children = [];
            return;
          }
          if (parsed.inlineRefs.has(text)) {
            node.type = "prototype-inline";
            node.data = { placeholder: text };
            node.children = [];
            return;
          }
        }
      }
      if (node.type === "inlineCode" && parsed.inlineRefs.has(String(node.value))) {
        node.type = "prototype-inline";
        node.data = { placeholder: String(node.value) };
        node.children = [];
      }
    };
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      walk(node);
      if (node.children) for (const c of node.children) visit(c);
    };
    visit(tree);
  };
}

/** remark-rehype unknownHandler：将自定义 mdast 节点转为带 data-proto 属性的占位元素 */
function protoUnknownHandler(_state: unknown, node: any) {
  const ph = String(node.data?.placeholder ?? "");
  return {
    type: "element",
    tagName: "div",
    properties: { "data-proto": node.type === "prototype-list" ? "list" : node.type === "prototype-inline" ? "inline" : "embed", "data-ph": ph },
    children: [],
  };
}

/** 由章节文本生成稳定锚点 id（用于目录定位，同时去除标题内的标记语法残留） */
function headingId(text: string): string {
  return text
    .replace(/[`*_#[]()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

interface PrdMarkdownProps {
  parsed: ParsedPrd;
}

export default function PrdMarkdown({ parsed }: PrdMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      // 覆盖默认组件，注入基础样式；h2/h3 带锚点 id 供目录定位
      h1: ({ children }) => <h1 id="prd-title" className="mt-8 mb-3 border-b border-slate-200 pb-2 text-xl font-semibold text-slate-900">{children}</h1>,
      h2: ({ children }) => <h2 id={headingId(textOf(children))} className="mt-7 mb-2 scroll-mt-24 text-lg font-semibold text-slate-900">{children}</h2>,
      h3: ({ children }) => <h3 id={headingId(textOf(children))} className="mt-5 mb-1.5 scroll-mt-24 text-base font-semibold text-slate-900">{children}</h3>,
      h4: ({ children }) => <h4 className="mt-4 mb-1 text-sm font-semibold text-slate-900">{children}</h4>,
      p: ({ children }) => <p className="my-2 leading-6 text-slate-700">{children}</p>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6 text-slate-700">{children}</ul>,
      ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6 text-slate-700">{children}</ol>,
      li: ({ children }) => <li className="leading-6">{children}</li>,
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-slate-700">{children}</th>
      ),
      td: ({ children }) => <td className="border border-slate-200 px-3 py-2 text-slate-700">{children}</td>,
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer" className="text-brand-600 underline-offset-2 hover:underline">
          {children}
        </a>
      ),
      // 行内 code 用浅色底；块级 code（pre 内）样式由 index.css 的 pre code 规则覆盖为透明继承
      code: ({ className, children }) => (
        <code className={`rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800 ${className ?? ""}`}>
          {children}
        </code>
      ),
      // 块级 code（pre 内）：识别 mermaid 代码块渲染为图，其余保持深色代码块
      pre: ({ children }) => {
        // react-markdown 的 pre 收 children 为 <code className="language-xxx">…</code>
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
          <pre className="my-3 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[13px] leading-5 text-slate-100">
            {children}
          </pre>
        );
      },
      blockquote: ({ children }) => (
        <blockquote className="my-3 border-l-4 border-brand-200 bg-brand-50/50 px-4 py-2 text-sm text-slate-600">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-6 border-slate-200" />,
      // 拦截 unknownHandler 产出的占位 div，渲染为内嵌原型 / 清单 / 引用
      div: ({ children, ...props }: any) => {
        const proto = props["data-proto"];
        if (proto) {
          const ph: string = props["data-ph"] ?? "";
          if (proto === "embed") {
            const spec = parsed.embeds.get(ph);
            return spec ? <PrototypeEmbed spec={spec} /> : null;
          }
          if (proto === "list") return <PrototypeList placeholder={ph} parsed={parsed} />;
          if (proto === "inline") {
            const id = parsed.inlineRefs.get(ph);
            return id ? (
              <a href={`#${id}`} className="mx-0.5 inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 align-middle text-xs font-medium text-brand-700 ring-1 ring-brand-500/20">
                原型「{id}」↗
              </a>
            ) : null;
          }
        }
        return <div {...props}>{children}</div>;
      },
    }) as Components,
    [parsed],
  );

  const remarkPlugins = useMemo(() => [placeholderPlugin(parsed), remarkGfm], [parsed]);
  // remark-rehype 的 unknownHandler 未在其公开类型中导出，此处透传（运行时被 remark-rehype 读取）
  const remarkRehypeOptions = useMemo(
    () => ({ unknownHandler: protoUnknownHandler }) as unknown as Record<string, unknown>,
    [],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      remarkRehypeOptions={remarkRehypeOptions}
      components={components}
    >
      {parsed.markdown}
    </ReactMarkdown>
  );
}

/** 原型清单：列出当前 PRD 引用的所有原型（默认链接形式，可 embed） */
function PrototypeList({ placeholder, parsed }: { placeholder: string; parsed: ParsedPrd }) {
  const listSpec = parsed.lists.get(placeholder);
  const ids = [...parsed.embeds.values()].map((e) => e.id);
  const unique = [...new Set(ids)];
  if (listSpec?.embed) {
    return (
      <div className="my-4 space-y-3">
        {unique.map((id) => (
          <PrototypeEmbed key={id} spec={{ id, title: id }} />
        ))}
      </div>
    );
  }
  return (
    <div className="my-3 rounded-lg border border-slate-200 bg-white p-3">
      <p className="mb-2 text-xs font-medium text-slate-500">本 PRD 引用原型（{unique.length}）</p>
      <div className="flex flex-wrap gap-2">
        {unique.map((id) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-600"
          >
            {id}
          </a>
        ))}
      </div>
    </div>
  );
}
