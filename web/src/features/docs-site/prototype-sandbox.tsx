"use client";
import { useEffect, useRef, useState } from "react";
import { getAuthToken, API_BASE_URL } from "@/lib/api";
import type { DeviceType } from "./types";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

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

const SHARED_FILES = ["index.ts", "styles.ts", "components.tsx", "nav.tsx", "types.ts", "ui.tsx"];

function resolveSharedFile(spec: string): string | null {
  const name = spec.replace(/^(\.\.?\/)+/, "").replace(/^_shared\//, "").replace(/^@proto\/shared\/?/, "").replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!name || name === "." || name === "index" || name === "shared") return "index.ts";
  return SHARED_FILES.find((f) => f.replace(/\.(ts|tsx)$/, "") === name) ?? null;
}

function protoCompilePlugin(): import("esbuild-wasm").Plugin {
  const SHARED_NS = "proto-shared";
  const REACT_NS = "proto-react";
  const REACT_DOM_NS = "proto-react-dom";
  const EMPTY_NS = "proto-empty";
  return {
    name: "proto-shared",
    setup(build) {
      build.onResolve({ filter: /^react(\/.*)?$/ }, (args) => {
        if (args.path === "react" || args.path === "react/jsx-runtime" || args.path === "react/jsx-dev-runtime") return { path: args.path, namespace: REACT_NS };
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: REACT_NS }, () => ({
        loader: "js",
        contents: `const R=globalThis.React;export default R;export const useState=R.useState;export const useEffect=R.useEffect;export const useRef=R.useRef;export const useMemo=R.useMemo;export const useCallback=R.useCallback;`,
      }));
      build.onResolve({ filter: /^react-dom(\/.*)?$/ }, (args) => {
        if (args.path === "react-dom" || args.path === "react-dom/client") return { path: args.path, namespace: REACT_DOM_NS };
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: REACT_DOM_NS }, () => ({
        loader: "js",
        contents: `const C=globalThis.ReactDOMClient||{};const D=globalThis.ReactDOM||{};export default C.createRoot?C:D;export const createRoot=C.createRoot;`,
      }));
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@proto/shared") return { path: "index.ts", namespace: SHARED_NS };
        if (args.path.startsWith("@proto/shared/")) { const f = resolveSharedFile(args.path.slice("@proto/shared/".length)); if (f) return { path: f, namespace: SHARED_NS }; }
        if (args.namespace === SHARED_NS) { const f = resolveSharedFile(args.path); if (f) return { path: f, namespace: SHARED_NS }; return { path: "index.ts", namespace: SHARED_NS }; }
        const m = /_shared\/(.+)$/.exec(args.path);
        if (m) { const f = resolveSharedFile(m[1]); if (f) return { path: f, namespace: SHARED_NS }; }
        if (args.path.startsWith("@md-docs/")) return { path: args.path, namespace: EMPTY_NS };
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: SHARED_NS }, () => ({ loader: "js", contents: "export const dummy=1;" }));
      build.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({ loader: "js", contents: "export default {};" }));
    },
  };
}

function encodeFile(file: string): string {
  return file.split("/").map((s) => encodeURIComponent(s)).join("/");
}

async function fetchPrototypeSource(taskId: string, file: string): Promise<string> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}/docs-site/${taskId}/prototypes/${encodeFile(file)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchRuntimeJs(): Promise<string> {
  const res = await fetch("/vendor/react-runtime.js");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function collectCss(): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      try {
        const text = rule.cssText;
        if (text && !seen.has(text)) { seen.add(text); parts.push(text); }
      } catch {}
    }
  }
  return parts.join("\n");
}

const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const escStyle = (s: string) => s.replace(/<\/style/gi, "<\\/style");

function buildSrcdoc(runtimeJs: string, bundleCode: string, cssText: string): string {
  const renderScript = `(function(){var rootEl=document.getElementById('root');var mod=globalThis.__ProtoModule||{};var raw=mod.default||mod.Component;var Component=raw&&typeof raw==='object'&&typeof raw.Component==='function'?raw.Component:raw;if(typeof Component!=='function'){rootEl.textContent='原型未导出默认组件';return;}var client=globalThis.ReactDOMClient;var React=globalThis.React;if(client&&client.createRoot&&React){client.createRoot(rootEl).render(React.createElement(Component));}else if(globalThis.ReactDOM&&React){globalThis.ReactDOM.render(React.createElement(Component),rootEl);}else{rootEl.textContent='React runtime 缺失';return;}function reportHeight(){var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0,rootEl.scrollHeight);if(window.parent&&window.parent!==window){window.parent.postMessage({type:'proto-height',height:h},'*');}}setTimeout(reportHeight,80);if(typeof ResizeObserver!=='undefined'){try{new ResizeObserver(reportHeight).observe(rootEl);}catch(e){}}})();`;
  const baseStyle = `html,body{margin:0;padding:0;min-height:100%;background:#f8fafc;}#root{min-height:100%;}*{box-sizing:border-box;}`;
  const tailwindCdn = `<script src="https://cdn.tailwindcss.com"><\/script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />${tailwindCdn}<style>${baseStyle}</style><style>${escStyle(cssText)}</style></head><body><div id="root"></div><script>${esc(runtimeJs)}</script><script>${esc(bundleCode)}</script><script>${esc(renderScript)}</script></body></html>`;
}

async function compilePrototype(source: string): Promise<{ bundleCode: string; bundleCss: string }> {
  const esbuild = await ensureEsbuild();
  const result = await esbuild.build({
    stdin: { contents: source, loader: "tsx", sourcefile: "prototype/index.tsx", resolveDir: "/" },
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
  if (result.errors.length > 0) throw new Error(`原型编译失败：\n${result.errors.map((e) => e.text).join("\n")}`);
  const files = result.outputFiles ?? [];
  const bundleCode = files[0]?.text;
  if (!bundleCode) throw new Error("原型编译无输出");
  const bundleCss = files.length > 1 ? files[1].text : "";
  return { bundleCode, bundleCss };
}

export function PrototypeSandbox({ taskId, file, name, device }: { taskId: string; file: string; name: string; device?: DeviceType }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; srcdoc: string }>({ status: "loading" });
  const [height, setHeight] = useState(480);
  const isFramed = !!device;
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const [source, runtimeJs] = await Promise.all([fetchPrototypeSource(taskId, file), fetchRuntimeJs()]);
        if (cancelled) return;
        const { bundleCode, bundleCss } = await compilePrototype(source);
        if (cancelled) return;
        const parentCss = collectCss();
        if (cancelled) return;
        const cssText = bundleCss ? bundleCss + "\n" + parentCss : parentCss;
        const srcdoc = buildSrcdoc(runtimeJs, bundleCode, cssText);
        setState({ status: "ready", srcdoc });
        setHeight(480);
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [taskId, file]);
  useEffect(() => {
    if (isFramed) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; height?: number } | null;
      if (data && data.type === "proto-height" && typeof data.height === "number") {
        const h = Math.min(Math.max(Math.round(data.height), 120), 4096);
        setHeight((prev) => (prev === h ? prev : h));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isFramed]);
  if (state.status === "loading") return <div style={{ display: "flex", minHeight: 280, alignItems: "center", justifyContent: "center", backgroundColor: neutral[50], padding: `${space.lg * 2}px 0`, fontSize: fontSize.md, color: neutral[400], fontFamily: fontFamily.body }}><span style={{ display: "inline-flex", alignItems: "center", gap: space.sm, borderRadius: radius.pill, border: `1px solid ${border}`, backgroundColor: surface, padding: `${space.sm}px ${space.lg}px` }}>编译原型「{name}」…</span></div>;
  if (state.status === "error") return <div data-testid="proto-error" style={{ margin: `${space.xl}px ${space.lg}px`, borderRadius: radius.sm, border: "1px dashed rgba(239,68,68,0.4)", backgroundColor: "rgba(254,242,242,0.6)", padding: space.lg, fontFamily: fontFamily.body }}><p style={{ marginBottom: 4, fontSize: fontSize.md, fontWeight: 500, color: "#B91C1C" }}>原型「{name}」渲染失败</p><pre style={{ whiteSpace: "pre-wrap", fontSize: fontSize.xs, color: "#DC2626", fontFamily: fontFamily.mono }}>{state.message}</pre></div>;
  if (isFramed) return <iframe title={`原型 ${name}`} data-testid="proto-frame" sandbox="allow-scripts" srcDoc={state.srcdoc} style={{ display: "block", width: "100%", height: "100%", border: "none", backgroundColor: "#f8fafc" }} />;
  return <iframe title={`原型 ${name}`} data-testid="proto-frame" sandbox="allow-scripts" srcDoc={state.srcdoc} style={{ display: "block", width: "100%", height, border: "none", backgroundColor: "#f8fafc" }} />;
}
