#!/usr/bin/env node
/**
 * sync-runtime.mjs — 同步 iframe 原型渲染所需的运行时资产
 * =====================================================
 * 产出（web/public/ 下，浏览器可直接访问）：
 *   1. public/vendor/react-runtime.js
 *      React 19 已移除 UMD 构建，故在构建期用 esbuild 将 react + react-dom/client
 *      打包为自包含 IIFE，挂全局 React / ReactDOM / ReactDOMClient。
 *      原型 iframe 的 srcdoc 以 <script> 文本注入，无需网络加载（sandbox null
 *      origin 下规避 CORS）。
 *   2. public/esbuild/esbuild.wasm
 *      esbuild-wasm 的 wasm 二进制，供原型 tab 在浏览器端 initialize 使用。
 *
 * 触发：web/package.json 的 postinstall（自动）+ sync:runtime（手动）。
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const vendorDir = join(webRoot, "public", "vendor");
const esbuildDir = join(webRoot, "public", "esbuild");
const sharedDir = join(webRoot, "src", "components", "docs", "proto-shared");
mkdirSync(vendorDir, { recursive: true });
mkdirSync(esbuildDir, { recursive: true });

/* ---------------- 0. proto-shared 源码 map（浏览器端 esbuild bundle 输入） ---------------- */
const sharedFiles = [
  "index.ts",
  "styles.ts",
  "components.tsx",
  "nav.tsx",
  "ui.tsx",
  "types.ts",
];
const sharedSources = {};
for (const f of sharedFiles) {
  sharedSources[f] = readFileSync(join(sharedDir, f), "utf8");
}
const sharedJson = JSON.stringify(sharedSources, null, 2)
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
writeFileSync(
  join(sharedDir, "sources.generated.ts"),
  `// 由 scripts/sync-runtime.mjs 自动生成（postinstall / sync:runtime），勿手改。
// 平台 proto-shared 各模块的源码文本，供原型 TSX 浏览器端编译（esbuild-wasm）时作为 bundle 输入。
export const PROTO_SHARED_SOURCES: Record<string, string> = ${sharedJson};
`,
);

/* ---------------- 1. React runtime bundle ---------------- */

const wasmPath = join(
  dirname(require.resolve("esbuild-wasm/package.json")),
  "esbuild.wasm"
);
const { initialize, build } = await import("esbuild-wasm");
// Node 环境无需指定 wasmURL（esbuild-wasm 自动加载本地二进制）；仅浏览器端需要
await initialize(typeof window === "undefined" ? {} : { wasmURL: wasmPath });

// 临时入口：挂全局（react-dom 19 的 ESM wrapper 内部依赖 react，打包时自动内联）
const entryPath = join(webRoot, "node_modules", ".proto-runtime-entry.js");
writeFileSync(
  entryPath,
  [
    "import * as React from 'react';",
    "import * as ReactDOM from 'react-dom';",
    "import * as ReactDOMClient from 'react-dom/client';",
    "globalThis.React = React;",
    "globalThis.ReactDOM = ReactDOM;",
    "globalThis.ReactDOMClient = ReactDOMClient;",
  ].join("\n"),
);

const reactRuntimeOut = join(vendorDir, "react-runtime.js");
const result = await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  outfile: reactRuntimeOut,
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  target: "es2017",
  legalComments: "none",
  logLevel: "warning",
});
if (result.errors.length > 0) {
  for (const e of result.errors) console.error("[sync-runtime] esbuild error:", e);
  process.exit(1);
}

/* ---------------- 2. esbuild.wasm ---------------- */

const wasmOut = join(esbuildDir, "esbuild.wasm");
copyFileSync(wasmPath, wasmOut);

console.log(
  `[sync-runtime] done → ${reactRuntimeOut} (${(statSync(reactRuntimeOut).size / 1024).toFixed(0)}KB), ${wasmOut}, ${join(sharedDir, "sources.generated.ts")}`,
);
