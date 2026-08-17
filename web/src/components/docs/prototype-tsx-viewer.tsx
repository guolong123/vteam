"use client";

/**
 * PrototypeTsxViewer：TSX 原型动态渲染（对齐 md-docs）
 * =============================================================
 * 编译链路：agent 原型 TSX 源码 → esbuild-wasm（浏览器端 bundle）→
 * iframe sandbox（allow-scripts，无 allow-same-origin）内 React 渲染。
 *
 * 设计要点：
 * - 共享库解析：`@proto/shared`、`../_shared/*`、`@md-docs/*` 相对路径在
 *   esbuild plugin 的 onResolve/onLoad 中解析到平台内置 proto-shared 模块
 *   （源码文本来自 sources.generated.ts，postinstall 生成）。
 * - react / react-dom 走虚拟模块：iframe 内使用全局 React/ReactDOMClient
 *   （runtime 由构建期 sync-runtime.mjs 打包，React 19 无 UMD，故自打包）。
 * - JSX 用经典模式（React.createElement），产物 IIFE + globalName
 *   __ProtoModule，iframe 内读取 mod.default 渲染到 #root。
 * - 样式：从主窗口提取全局样式表文本（含 globals.css reset + Tailwind
 *   theme/utilities）注入 srcdoc <style>，agent 的 Tailwind 工具类可用。
 * - 高度自适应：iframe 内脚本 postMessage { type:'proto-height' }，
 *   父窗口监听调整 iframe 高度。
 *
 * 安全：iframe sandbox="allow-scripts"（无 allow-same-origin），agent 代码
 * 运行在 null origin 沙箱内，无法访问平台 DOM / cookie / storage。
 */
import { useEffect, useRef, useState } from "react";
import { PROTO_SHARED_SOURCES } from "./proto-shared/sources.generated";
import { getAuthToken } from "@/lib/api";

/* ---------- esbuild-wasm 单例初始化（浏览器端） ---------- */

type EsbuildApi = typeof import("esbuild-wasm");

let esbuildPromise: Promise<EsbuildApi> | null = null;

function ensureEsbuild(): Promise<EsbuildApi> {
  if (!esbuildPromise) {
    esbuildPromise = import("esbuild-wasm").then(async (mod) => {
      await mod.initialize({ wasmURL: "/esbuild/esbuild.wasm" });
      return mod;
    });
  }
  return esbuildPromise;
}

/* ---------- 共享库源码 map（postinstall 生成） ---------- */

const SHARED_FILES = Object.keys(PROTO_SHARED_SOURCES);

function resolveSharedFile(spec: string): string | null {
  const name = spec
    .replace(/^(\.\.?\/)+/, "")
    .replace(/^_shared\//, "")
    .replace(/^@proto\/shared\/?/, "")
    .replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!name || name === "." || name === "index" || name === "shared") {
    return "index.ts";
  }
  return SHARED_FILES.find((f) => f.replace(/\.(ts|tsx)$/, "") === name) ?? null;
}

/**
 * esbuild plugin：把共享库别名与 react/react-dom 解析为浏览器端可用模块。
 */
function protoCompilePlugin(): import("esbuild-wasm").Plugin {
  const SHARED_NS = "proto-shared";
  const REACT_NS = "proto-react";
  const REACT_DOM_NS = "proto-react-dom";
  const EMPTY_NS = "proto-empty";

  return {
    name: "proto-shared",
    setup(build) {
      // react 家族 → 虚拟模块（iframe 内取全局 React）
      build.onResolve({ filter: /^react(\/.*)?$/ }, (args) => {
        if (
          args.path === "react" ||
          args.path === "react/jsx-runtime" ||
          args.path === "react/jsx-dev-runtime"
        ) {
          return { path: args.path, namespace: REACT_NS };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: REACT_NS }, () => ({
        loader: "js",
        contents: `
          const R = globalThis.React;
          if (!R) throw new Error("[proto] React runtime 未在 iframe 中加载");
          export default R;
          export const useState = R.useState;
          export const useEffect = R.useEffect;
          export const useRef = R.useRef;
          export const useMemo = R.useMemo;
          export const useCallback = R.useCallback;
          export const useContext = R.useContext;
          export const useReducer = R.useReducer;
          export const useLayoutEffect = R.useLayoutEffect;
          export const useInsertionEffect = R.useInsertionEffect;
          export const useId = R.useId;
          export const useTransition = R.useTransition;
          export const useDeferredValue = R.useDeferredValue;
          export const Fragment = R.Fragment;
          export const StrictMode = R.StrictMode;
          export const Suspense = R.Suspense;
          export const createElement = R.createElement;
          export const cloneElement = R.cloneElement;
          export const isValidElement = R.isValidElement;
          export const createContext = R.createContext;
          export const createRef = R.createRef;
          export const forwardRef = R.forwardRef;
          export const memo = R.memo;
          export const Children = R.Children;
          export const startTransition = R.startTransition;
        `,
      }));

      // react-dom / react-dom/client → 虚拟模块
      build.onResolve({ filter: /^react-dom(\/.*)?$/ }, (args) => {
        if (args.path === "react-dom" || args.path === "react-dom/client") {
          return { path: args.path, namespace: REACT_DOM_NS };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: REACT_DOM_NS }, () => ({
        loader: "js",
        contents: `
          const C = globalThis.ReactDOMClient || {};
          const D = globalThis.ReactDOM || {};
          export default C.createRoot ? C : D;
          export const createRoot = C.createRoot;
          export const render = D.render;
          export const hydrateRoot = C.hydrateRoot;
        `,
      }));

      // 共享库别名解析
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@proto/shared") {
          return { path: "index.ts", namespace: SHARED_NS };
        }
        if (args.path.startsWith("@proto/shared/")) {
          const f = resolveSharedFile(args.path.slice("@proto/shared/".length));
          if (f) return { path: f, namespace: SHARED_NS };
        }
        // 共享库内部相对导入（./styles → styles.ts）
        if (args.namespace === SHARED_NS) {
          const f = resolveSharedFile(args.path);
          if (f) return { path: f, namespace: SHARED_NS };
          return { path: "index.ts", namespace: SHARED_NS };
        }
        // agent 原型相对 ../_shared/* 或 ../../_shared/*
        const m = /_shared\/(.+)$/.exec(args.path);
        if (m) {
          const f = resolveSharedFile(m[1]);
          if (f) return { path: f, namespace: SHARED_NS };
        }
        // md-docs 规范的 @md-docs/*（type-only 导入兜底）
        if (args.path.startsWith("@md-docs/")) {
          return { path: args.path, namespace: EMPTY_NS };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: SHARED_NS }, (args) => {
        const contents = PROTO_SHARED_SOURCES[args.path];
        if (contents === undefined) {
          return {
            errors: [{ text: `[proto] proto-shared 模块不存在: ${args.path}` }],
          };
        }
        const loader = args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".ts")
            ? "ts"
            : "js";
        return { contents, loader };
      });
      build.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({
        loader: "js",
        contents: "export default {}; export {};",
      }));
    },
  };
}

/* ---------- 原型源码拉取 ---------- */

function encodeFile(file: string): string {
  return file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function fetchPrototypeSource(taskId: string, file: string): Promise<string> {
  const token = getAuthToken();
  const res = await fetch(
    `${"/api/v1/docs-site/" + taskId + "/prototypes/"}${encodeFile(file)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) {
    throw new Error(`加载原型源码失败 (HTTP ${res.status})`);
  }
  return res.text();
}

async function fetchRuntimeJs(): Promise<string> {
  const res = await fetch("/vendor/react-runtime.js");
  if (!res.ok) {
    throw new Error(`React runtime 加载失败 (HTTP ${res.status})`);
  }
  return res.text();
}

/* ---------- 样式提取（主窗口全局样式 → iframe srcdoc <style>） ---------- */

function collectCss(): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      try {
        const text = rule.cssText;
        if (text && !seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      } catch {
        // 个别规则（如 @font-face 跨源）读取失败则跳过
      }
    }
  }
  return parts.join("\n");
}

/* ---------- iframe srcdoc 构建 ---------- */

const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const escStyle = (s: string) => s.replace(/<\/style/gi, "<\\/style");

function buildSrcdoc(runtimeJs: string, bundleCode: string, cssText: string): string {
  const renderScript = `
    (function () {
      var rootEl = document.getElementById('root');
      var mod = globalThis.__ProtoModule || {};
      // 兼容两种默认导出形态：直接组件函数，或 md-docs PrototypeDef 对象 { meta, Component }
      var raw = mod.default || mod.Component;
      var Component =
        raw && typeof raw === 'object' && typeof raw.Component === 'function'
          ? raw.Component
          : raw;
      if (typeof Component !== 'function') {
        rootEl.textContent = '原型未导出默认组件（export default App 或 { meta, Component }）';
        return;
      }
      var client = globalThis.ReactDOMClient;
      var React = globalThis.React;
      if (client && client.createRoot && React) {
        client.createRoot(rootEl).render(React.createElement(Component));
      } else if (globalThis.ReactDOM && React) {
        globalThis.ReactDOM.render(React.createElement(Component), rootEl);
      } else {
        rootEl.textContent = 'React runtime 缺失';
        return;
      }
      function reportHeight() {
        var h = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0,
          rootEl.scrollHeight
        );
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'proto-height', height: h }, '*');
        }
      }
      setTimeout(reportHeight, 80);
      if (typeof ResizeObserver !== 'undefined') {
        try { new ResizeObserver(reportHeight).observe(rootEl); } catch (e) {}
      }
    })();
  `;

  const baseStyle = `
    html, body { margin: 0; padding: 0; min-height: 100%; background: #F8FAFC; }
    #root { min-height: 100%; }
    * { box-sizing: border-box; }
  `;

  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\" />" +
    `<style>${baseStyle}</style>` +
    `<style>${escStyle(cssText)}</style>` +
    "</head><body>" +
    `<div id="root"></div>` +
    `<script>${esc(runtimeJs)}</script>` +
    `<script>${esc(bundleCode)}</script>` +
    `<script>${esc(renderScript)}</script>` +
    "</body></html>"
  );
}

/* ---------- 编译流程 ---------- */

async function compilePrototype(source: string): Promise<string> {
  const esbuild = await ensureEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents: source,
      loader: "tsx",
      sourcefile: "prototype/index.tsx",
      resolveDir: "/",
    },
    bundle: true,
    format: "iife",
    globalName: "__ProtoModule",
    jsx: "transform",
    charset: "utf8",
    target: "es2017",
    logLevel: "silent",
    write: false,
    plugins: [protoCompilePlugin()],
  });
  if (result.errors.length > 0) {
    const msgs = result.errors.map((e) => {
      const loc = e.location
        ? ` (${e.location.file}:${e.location.line}:${e.location.column})`
        : "";
      return `${e.text}${loc}`;
    });
    throw new Error(`原型编译失败：\n${msgs.join("\n")}`);
  }
  const output = result.outputFiles?.[0]?.text;
  if (!output) {
    throw new Error("原型编译无输出");
  }
  return output;
}

/* ---------- 组件 ---------- */

export interface PrototypeTsxViewerProps {
  taskId: string;
  /** 原型文件路径，如 `<name>/index.tsx` */
  file: string;
  /** 展示名称（错误/加载提示用） */
  name: string;
}

type ViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; srcdoc: string };

export function PrototypeTsxViewer({ taskId, file, name }: PrototypeTsxViewerProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [height, setHeight] = useState(480);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcdocRef = useRef<string | null>(null);

  // 编译：源码 → esbuild-wasm → 自包含 IIFE → srcdoc
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const [source, runtimeJs] = await Promise.all([
          fetchPrototypeSource(taskId, file),
          fetchRuntimeJs(),
        ]);
        if (cancelled) return;
        const bundleCode = await compilePrototype(source);
        if (cancelled) return;
        const cssText = collectCss();
        if (cancelled) return;
        const srcdoc = buildSrcdoc(runtimeJs, bundleCode, cssText);
        srcdocRef.current = srcdoc;
        setState({ status: "ready", srcdoc });
        setHeight(480);
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [taskId, file]);

  // 高度自适应：iframe 内 postMessage 报告内容高度
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; height?: number } | null;
      if (data && data.type === "proto-height" && typeof data.height === "number") {
        const h = Math.min(Math.max(Math.round(data.height), 120), 4096);
        setHeight((prev) => (prev === h ? prev : h));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-64 items-center justify-center py-16 text-sm text-slate-400">
        编译原型「{name}」…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-testid="proto-error"
        className="mx-4 my-6 rounded-lg border border-dashed border-danger-200 bg-danger-50/40 p-4"
      >
        <p className="mb-1 text-sm font-medium text-danger-700">
          原型「{name}」渲染失败
        </p>
        <pre className="whitespace-pre-wrap text-xs leading-relaxed text-danger-600/90">
          {state.message}
        </pre>
      </div>
    );
  }

  return (
    <iframe
      key={state.srcdoc}
      ref={frameRef}
      title={`原型 ${name}`}
      data-testid="proto-frame"
      sandbox="allow-scripts"
      srcDoc={state.srcdoc}
      style={{
        display: "block",
        width: "100%",
        height,
        border: "none",
        backgroundColor: "#F8FAFC",
      }}
    />
  );
}
