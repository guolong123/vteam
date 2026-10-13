/**
 * doc-pdf-export 冒烟（暗色导出可读性 / 页边距 / 断页）
 * ==================================================
 * 测试缝（自包含、零落盘）：esbuild-wasm 现编译入口为 IIFE → setContent 空白页注入
 * 真实 globals.css 的 :root/.dark 变量块 → 以 HTML 变量内联样式构造样例文档 →
 * 调用真实 exportNodeToPdf（仅把 jspdf 替换为捕获桩，html2canvas 真实执行）→
 * 解码页面 PNG 做像素断言。设计先例：e2e/chat-density.spec.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const WEB_ROOT = path.resolve(__dirname, "..");
const GLOBALS_CSS = readFileSync(path.join(WEB_ROOT, "app", "globals.css"), "utf8");

/** 提取包含指定标记的规则块（同名选择器可能多处：如 :root ×2、.dark 与 .dark :focus-visible）。 */
function extractBlock(selector: string, marker: string): string {
  let from = 0;
  for (;;) {
    const index = GLOBALS_CSS.indexOf(selector, from);
    if (index < 0) throw new Error(`globals.css 缺少含 ${marker} 的 ${selector} 块`);
    // 选择器必须紧跟 `{`（可选空白）——注释里出现的同名字样（如「在 :root 为浅色」）须跳过，
    // 否则截出的块带注释前缀会被 CSS 解析器整块丢弃（变量全失效）。
    const tail = GLOBALS_CSS.slice(index + selector.length);
    if (!/^\s*\{/.test(tail)) {
      from = index + selector.length;
      continue;
    }
    const open = GLOBALS_CSS.indexOf("{", index);
    let depth = 0;
    for (let i = open; i < GLOBALS_CSS.length; i += 1) {
      if (GLOBALS_CSS[i] === "{") depth += 1;
      else if (GLOBALS_CSS[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          const block = GLOBALS_CSS.slice(index, i + 1);
          if (block.includes(marker)) return block;
          break;
        }
      }
    }
    from = index + selector.length;
  }
}

const THEME_CSS = `${extractBlock(":root", "--color-neutral-50")}\n${extractBlock(".dark", "--color-neutral-50")}`;

const HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8" />
<style>${THEME_CSS}</style>
<style>body{margin:0;background:var(--color-bg)}</style>
</head><body></body></html>`;

/** 入口源码：真实 doc-export + 样例文档 + 运行器（jspdf 经插件桩替换）。 */
const ENTRY_SOURCE = `
import { exportNodeToPdf } from "./src/features/docs-site/doc-export";

const pages: Array<{ dataUrl: string; x: number; y: number; w: number; h: number }> = [];
(globalThis as unknown as { __pdfPages: typeof pages }).__pdfPages = pages;

function sample(): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "background:var(--color-bg);color:var(--color-text);padding:24px;font-family:sans-serif;width:746px;box-sizing:border-box";
  const parts: string[] = [];
  parts.push("<h1 style=\\"color:var(--color-neutral-900);font-size:24px;margin:0 0 12px\\">暗色导出样例标题</h1>");
  parts.push("<p id=\\"lead\\" style=\\"color:var(--color-neutral-700);font-size:14px;line-height:1.7;margin:0 0 10px\\">导言段：验证普通正文文字导出后为深色可读。</p>");
  parts.push("<p style=\\"color:var(--color-neutral-700);font-size:14px;line-height:1.7;margin:0 0 10px\\">方法：<code id=\\"longchip\\" style=\\"background-color:var(--color-neutral-100);border-radius:6px;padding:2px 6px;color:var(--color-neutral-800);font-family:monospace;font-size:12px\\">ketacli curl / ketacli asset repo / ketacli search / ketacli mock / ketacli verify</code>，辅以 HTTP 接口与代码走查。</p>");
  parts.push("<p style=\\"color:var(--color-neutral-700);font-size:14px;line-height:1.7;margin:0 0 10px\\">短芯片对照：<code id=\\"shortchip\\" style=\\"background-color:var(--color-neutral-100);border-radius:6px;padding:2px 6px;color:var(--color-neutral-800);font-family:monospace;font-size:12px\\">ketacli mock</code> 结束。</p>");
  parts.push("<table style=\\"border-collapse:collapse;width:100%;font-size:14px\\"><thead style=\\"background:var(--color-neutral-50)\\"><tr><th style=\\"border:1px solid var(--color-neutral-200);padding:6px;color:var(--color-neutral-800);text-align:left\\">检查项</th><th style=\\"border:1px solid var(--color-neutral-200);padding:6px;color:var(--color-neutral-800)\\">要求</th></tr></thead><tbody><tr><td style=\\"border:1px solid var(--color-neutral-200);padding:6px;color:var(--color-neutral-800)\\">JRE 21</td><td style=\\"border:1px solid var(--color-neutral-200);padding:6px;color:var(--color-neutral-800)\\">运行需 JRE 21</td></tr></tbody></table>");
  parts.push("<div style=\\"background:var(--color-neutral-100);border:1px solid var(--color-neutral-200);border-radius:8px;padding:12px;margin:12px 0\\"><pre style=\\"margin:0;color:var(--color-neutral-800);font-family:monospace;font-size:13px\\">java -version</pre></div>");
  parts.push("<blockquote style=\\"margin:12px 0;padding:8px 16px;border-left:3px solid var(--color-neutral-300);background:var(--color-neutral-50);color:var(--color-neutral-600)\\">引用块：验证浅底深字。</blockquote>");
  for (let i = 0; i < 40; i += 1) {
    parts.push("<p style=\\"color:var(--color-neutral-700);font-size:14px;line-height:1.7;margin:0 0 10px\\">段落 " + i + "：验证正文文字导出后为深色可读，并制造跨页内容。</p>");
  }
  root.innerHTML = parts.join("");
  return root;
}

(globalThis as unknown as { __runExport: (dark: boolean) => Promise<{ pages: typeof pages; probe: unknown }> }).__runExport = async (dark: boolean) => {
  document.documentElement.classList.toggle("dark", dark);
  const node = sample();
  document.body.appendChild(node);
  // 探针必须按「克隆布局」测量：导出时克隆被定宽 794（PDF_WIDTH_PX），
  // 内容重排后的纵向位置与原始 746 宽节点不同（用原节点坐标探测会得到空白假阴性）。
  const replica = sample();
  replica.style.position = "absolute";
  replica.style.left = "-10000px";
  replica.style.width = "794px";
  replica.style.maxWidth = "794px";
  document.body.appendChild(replica);
  const repRect = replica.getBoundingClientRect();
  const rel = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - repRect.left, y: r.top - repRect.top, w: r.width, h: r.height };
  };
  const fxHost = document.createElement("div");
  fxHost.style.cssText = "position:fixed;left:-9999px;top:0;width:794px;background:#ffffff;z-index:-1";
  const fxClone = sample();
  fxClone.style.background = "#ffffff";
  fxClone.style.width = "794px";
  fxClone.style.maxWidth = "794px";
  fxClone.style.overflow = "visible";
  fxHost.appendChild(fxClone);
  document.body.appendChild(fxHost);
  const fixtureCloneH = fxClone.getBoundingClientRect().height;
  fxHost.remove();
  const probe = { text: rel(replica.querySelector("p")), code: rel(replica.querySelector("pre")), chip: rel(replica.querySelector("#longchip")), shortChip: rel(replica.querySelector("#shortchip")), nodeWidth: replica.clientWidth, replicaH: replica.getBoundingClientRect().height, fixtureCloneH, scrollY: window.scrollY, winH: window.innerHeight };
  replica.remove();
  await exportNodeToPdf(node, "smoke.pdf");
  node.remove();
  return { pages, probe };
};
`;

/** jspdf 桩（html2canvas 保持真实）：捕获 addImage 的几何与页面图供像素断言。 */
const JSPDF_STUB = `
export class jsPDF {
  constructor() {}
  addPage() {}
  addImage(dataUrl, format, x, y, w, h) {
    const g = globalThis.__pdfPages || (globalThis.__pdfPages = []);
    g.push({ dataUrl, format, x, y, w, h });
  }
  save() {}
}
`;

const stubJspdfPlugin: import("esbuild-wasm").Plugin = {
  name: "stub-jspdf",
  setup(build) {
    build.onResolve({ filter: /^jspdf$/ }, () => ({ path: "stub-jspdf", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: JSPDF_STUB, loader: "js" }));
  },
};

let harnessBundle: Promise<string> | null = null;
function buildHarness(): Promise<string> {
  if (!harnessBundle) {
    harnessBundle = (async () => {
      const esbuild = await import("esbuild-wasm");
      const result = await esbuild.build({
        stdin: { contents: ENTRY_SOURCE, loader: "tsx", resolveDir: WEB_ROOT, sourcefile: "doc-pdf-export-harness.tsx" },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2020",
        charset: "utf8",
        define: { "process.env.NODE_ENV": '"production"' },
        tsconfig: path.join(WEB_ROOT, "tsconfig.json"),
        plugins: [stubJspdfPlugin],
        logLevel: "silent",
      });
      const files = result.outputFiles ?? [];
      if (files.length === 0) throw new Error("doc-pdf-export harness: esbuild 无输出");
      return Buffer.from(files[0].contents).toString("utf8");
    })();
  }
  return harnessBundle;
}

test("暗色导出：文字深色可读 / 无深色块 / 页边距 / 页面高度有界", async ({ page }) => {
  const script = await buildHarness();
  await page.setContent(HARNESS_HTML);
  await page.addScriptTag({ content: script });

  type PdfPage = { dataUrl: string; x: number; y: number; w: number; h: number };
  type Rect = { x: number; y: number; w: number; h: number };
  type Probe = { text: Rect | null; code: Rect | null; chip: Rect | null; shortChip: Rect | null; nodeWidth: number };
  const result = await page.evaluate(
    () => (window as unknown as { __runExport: (d: boolean) => Promise<{ pages: PdfPage[]; probe: Probe }> }).__runExport(true),
  );
  const pages = result.pages;
  const probe = result.probe;
  expect(pages.length).toBeGreaterThan(0);

  for (const p of pages) {
    expect(p.x).toBeCloseTo(12, 1);
    expect(p.y).toBeCloseTo(12, 1);
    expect(p.w).toBeCloseTo(186, 0);
    expect(p.h).toBeLessThanOrEqual(273.5);
  }

  const metrics = await page.evaluate(async ({ first, probe }: { first: PdfPage; probe: Probe }) => {
    const decode = (dataUrl: string) =>
      new Promise<HTMLCanvasElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          if (!g) return reject(new Error("no ctx"));
          g.drawImage(img, 0, 0);
          resolve(c);
        };
        img.onerror = () => reject(new Error("decode fail"));
        img.src = dataUrl;
      });
    const canvas = await decode(first.dataUrl);
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no ctx");
    const scale = canvas.width / probe.nodeWidth;
    const lum = (r: number, gg: number, b: number) => 0.299 * r + 0.587 * gg + 0.114 * b;
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const lumAt = (x: number, y: number) => {
      const i = (y * canvas.width + x) * 4;
      return lum(data[i], data[i + 1], data[i + 2]);
    };
    let textMinLum = 255;
    if (probe.text) {
      const x0 = Math.round(probe.text.x * scale);
      const y0 = Math.round(probe.text.y * scale);
      const x1 = Math.min(canvas.width, Math.round((probe.text.x + probe.text.w) * scale));
      const y1 = Math.min(canvas.height, Math.round((probe.text.y + probe.text.h) * scale));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) textMinLum = Math.min(textMinLum, lumAt(x, y));
      }
    }
    let codeBgLum = 0;
    if (probe.code) {
      codeBgLum = lumAt(
        Math.min(canvas.width - 1, Math.round((probe.code.x + 6) * scale)),
        Math.min(canvas.height - 1, Math.round((probe.code.y + probe.code.h / 2) * scale)),
      );
    }
    let veryDark = 0;
    let total = 0;
    let cornerWhite = true;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const l = lumAt(x, y);
        total += 1;
        if (l < 80) veryDark += 1;
        if (x < 8 && y < 8 && l < 245) cornerWhite = false;
      }
    }
    const inkIn = (rect: Rect | null): number => {
      if (!rect) return -1;
      const x0 = Math.max(0, Math.round(rect.x * scale));
      const y0 = Math.max(0, Math.round(rect.y * scale));
      const x1 = Math.min(canvas.width, Math.round((rect.x + rect.w) * scale));
      const y1 = Math.min(canvas.height, Math.round((rect.y + rect.h) * scale));
      let ink = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (lumAt(x, y) < 120) ink += 1;
        }
      }
      return ink;
    };
    return { canvasW: canvas.width, canvasH: canvas.height, textMinLum, codeBgLum, longChipInk: inkIn(probe.chip), shortChipInk: inkIn(probe.shortChip), veryDarkRatio: veryDark / total, cornerWhite };
  }, { first: pages[0], probe });

  expect(metrics.textMinLum).toBeLessThan(120);
  expect(metrics.codeBgLum).toBeGreaterThan(200);
  console.log("METRICS", JSON.stringify({ ...metrics, cropChip: "omitted", cropCode: "omitted" }), "PROBE", JSON.stringify(probe));
  const fs = await import("node:fs");
  void fs;
  expect(metrics.shortChipInk).toBeGreaterThan(0);
  expect(metrics.longChipInk).toBeGreaterThan(0);
  expect(metrics.veryDarkRatio).toBeLessThan(0.08);
  expect(metrics.cornerWhite).toBe(true);
});
