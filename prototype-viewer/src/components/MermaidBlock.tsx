import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

/**
 * MermaidBlock：将 ```mermaid 代码块渲染为 SVG 图
 * =====================================================
 * 组件挂载后调用 mermaid.render 生成 SVG，经 dangerouslySetInnerHTML 注入。
 *  - 浅色主题（base + 品牌色浅调变量），适配文档白色背景；
 *  - 渲染期间显示加载占位；mermaid 语法错误/渲染失败时回退为原始代码块并提示；
 *  - 图容器可横向滚动（overflow-x-auto），宽图不撑破文档布局。
 */

/** 浅色主题变量：节点用品牌色浅调（brand-100/200），线条用 slate 系，标签底白 */
const MERMAID_THEME_VARIABLES = {
  primaryColor: "#e0ebfe", // brand-100
  primaryTextColor: "#1e293b", // slate-800
  primaryBorderColor: "#c7dafe", // brand-200
  secondaryColor: "#f8fafc", // slate-50
  tertiaryColor: "#f1f5f9", // slate-100
  lineColor: "#94a3b8", // slate-400
  edgeLabelBackground: "#ffffff",
  clusterBkg: "#f8fafc",
  clusterBorder: "#cbd5e1",
  fontSize: "14px",
} as const;

let initialized = false;
/** mermaid 全局只初始化一次，避免多实例并发 initialize 互相覆盖配置 */
function ensureMermaidInitialized() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: MERMAID_THEME_VARIABLES,
    securityLevel: "strict",
  });
  initialized = true;
}

let seq = 0;
/** 生成唯一 render id（mermaid.render 要求 id 唯一且非纯数字） */
function nextRenderId(): string {
  seq += 1;
  return `mmd-${Date.now().toString(36)}-${seq}`;
}

export default function MermaidBlock({ code }: { code: string }) {
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
      .catch((err) => {
        console.error("[MermaidBlock] mermaid 渲染失败:", err);
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // 渲染失败：回退为原始代码块（深色 pre 样式，与普通代码块一致），并给出提示
  if (failed) {
    return (
      <div className="my-3">
        <p className="mb-1 text-xs text-warning-700">图渲染失败，显示源码</p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[13px] leading-5 text-slate-100">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    );
  }

  // 渲染中：加载占位
  if (!svg) {
    return (
      <div className="my-3 flex h-24 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
        <span className="text-xs text-slate-400">渲染图中…</span>
      </div>
    );
  }

  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-slate-200 bg-white p-3">
      {/* mermaid.render 产物为可信 SVG，直接注入 */}
      <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
