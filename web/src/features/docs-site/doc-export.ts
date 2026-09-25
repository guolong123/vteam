/**
 * 文档导出工具（框架无关，零 React 依赖）
 * =========================================
 * - `exportNodeToPdf`：克隆 + 强制浅色 + 展平滚动容器 + 栅格化 mermaid SVG
 *   → html2canvas-pro 截图 → jsPDF 按 A4 纵向切片分页 → `pdf.save()`。
 * - `downloadTextAsFile`：Blob + 临时 `<a download>` 下载（Markdown 原文）。
 * - `resolveMarkdownSource`：按产出物类型解析可下载的 Markdown 文本。
 *
 * 约束：`html2canvas-pro` / `jspdf` 仅在函数体内动态 `import()`，SSR 与首屏
 * 包不受影响；本文件不含 JSX，可在任意环境 import（仅调用时依赖 DOM）。
 */

/** A4 宽度 @96dpi ≈ 794px（离屏渲染/克隆固定宽度）。 */
const PDF_WIDTH_PX = 794;

/** A4 尺寸（mm，纵向）。 */
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

/** 栅格化倍率（SVG → 位图，2x 保证清晰度）。 */
const SVG_RASTER_SCALE = 2;

/** 序列化后的 SVG 含 foreignObject 时无法可靠地经 `<img>` 栅格化（HTML 标签不渲染）。 */
const FOREIGN_OBJECT_TAG = "foreignObject";

/** 将 URL 加载为已解码的 `<img>`（onload/onerror → Promise）。 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG 图片加载失败"));
    image.src = url;
  });
}

/**
 * 内联 SVG → PNG dataURL（白色底、2x 画布）。
 * 失败（如含 foreignObject）由调用方兜底：保留内联 SVG。
 */
async function svgToDataUrl(svg: SVGSVGElement, width: number, height: number): Promise<string> {
  const serializedSvg = svg.cloneNode(true) as SVGSVGElement;
  if (!serializedSvg.getAttribute("xmlns")) {
    serializedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!serializedSvg.getAttribute("xmlns:xlink")) {
    serializedSvg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  }
  // 缺省显式尺寸时经 <img> 加载会解码为 0×0（viewBox 不足以定尺寸）。
  if (!serializedSvg.getAttribute("width")) {
    serializedSvg.setAttribute("width", String(Math.max(1, Math.round(width))));
  }
  if (!serializedSvg.getAttribute("height")) {
    serializedSvg.setAttribute("height", String(Math.max(1, Math.round(height))));
  }
  const markup = new XMLSerializer().serializeToString(serializedSvg);
  // mermaid 默认 htmlLabels 走 foreignObject：经 <img> 加载时 HTML 文本不渲染，
  // 视为栅格化失败，交由 html2canvas-pro 直接渲染内联 SVG。
  if (markup.includes(FOREIGN_OBJECT_TAG)) {
    throw new Error("SVG 含 foreignObject，无法可靠栅格化");
  }
  // data URL 比 Blob URL 更稳（无生命周期竞态，且不受 object URL 策略影响）。
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * SVG_RASTER_SCALE));
  canvas.height = Math.max(1, Math.round(height * SVG_RASTER_SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * 把 DOM 节点渲染为多页 A4 PDF 并触发下载。
 *
 * 步骤：克隆 → 强制浅色/定宽 → 展平 `overflow:auto|scroll` 容器 →
 * 逐个栅格化内联 SVG（失败保留原 SVG）→ 离屏宿主挂载 → html2canvas-pro
 * 截图 → 沿纵轴切片写入 jsPDF → `pdf.save(filename)`。
 */
export async function exportNodeToPdf(node: HTMLElement, filename: string): Promise<void> {
  // 1) 克隆（远离原 DOM，避免污染页面/深色主题）。
  const clone = node.cloneNode(true) as HTMLElement;

  // 2) 克隆上强制浅色主题 + A4 宽度，避免深色变量带进 PDF。
  clone.style.background = "#ffffff";
  clone.style.color = "#111827";
  clone.style.width = `${PDF_WIDTH_PX}px`;
  clone.style.maxWidth = `${PDF_WIDTH_PX}px`;
  clone.style.overflow = "visible";

  // 3) 展平滚动容器（代码块 / 表格外层）：原树结构一致，逐位读取原树 computed style。
  const originals = [node, ...Array.from(node.querySelectorAll<HTMLElement>("*"))];
  const clones = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
  for (let i = 0; i < clones.length; i += 1) {
    const source = originals[i];
    const target = clones[i];
    if (!source || !target) continue;
    const overflowX = window.getComputedStyle(source).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") {
      target.style.overflowX = "visible";
      target.style.overflowY = "visible";
      target.style.maxWidth = "none";
      // whiteSpace 保持不变（仅展平滚动，不改写换行语义）。
    }
  }

  // 4) mermaid / SVG：逐个尝试栅格化并替换为等宽 `<img>`；单个失败即保留原 SVG。
  const sourceSvgs = Array.from(node.querySelectorAll<SVGSVGElement>("svg"));
  const cloneSvgs = Array.from(clone.querySelectorAll<SVGSVGElement>("svg"));
  for (let i = 0; i < cloneSvgs.length; i += 1) {
    const target = cloneSvgs[i];
    const source = sourceSvgs[i] ?? target;
    const rect = source.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    try {
      const dataUrl = await svgToDataUrl(target, rect.width, rect.height);
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = source.getAttribute("aria-label") ?? "";
      image.style.display = "block";
      image.style.width = `${Math.round(rect.width)}px`;
      image.style.height = `${Math.round(rect.height)}px`;
      target.replaceWith(image);
      await image.decode().catch(() => undefined);
    } catch {
      // 栅格化失败：保留内联 SVG，html2canvas-pro 通常可直接渲染。
    }
  }

  // 5) 离屏宿主：视觉不可见、不影响布局，等待一帧让布局稳定。
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-9999px";
  host.style.top = "0";
  host.style.width = `${PDF_WIDTH_PX}px`;
  host.style.background = "#ffffff";
  host.style.zIndex = "-1";
  host.setAttribute("aria-hidden", "true");
  host.appendChild(clone);
  document.body.appendChild(host);

  try {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // 6) 等字体就绪，避免截图回退到系统字体导致排版偏移。
    await document.fonts?.ready.catch(() => undefined);

    // 7) 截图（html2canvas-pro 动态加载，不进首屏包）。
    const { default: html2canvas } = await import("html2canvas-pro");
    const canvas = await html2canvas(clone, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
    });
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      throw new Error("无法生成 PDF：内容为空或未渲染出画布");
    }

    // 8) A4 纵向切片分页。
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });
    const pxPerMm = canvas.width / A4_WIDTH_MM;
    const pagePx = A4_HEIGHT_MM * pxPerMm;
    const pageCount = Math.max(1, Math.ceil(canvas.height / pagePx));

    for (let page = 0; page < pageCount; page += 1) {
      const sliceTop = page * pagePx;
      const sliceHeight = Math.min(pagePx, canvas.height - sliceTop);
      if (sliceHeight <= 0) break;

      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const ctx = slice.getContext("2d");
      if (!ctx) throw new Error("无法创建切片画布上下文");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, sliceTop, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

      if (page > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/png"), "PNG", 0, 0, A4_WIDTH_MM, sliceHeight / pxPerMm);
    }

    pdf.save(filename);
  } finally {
    // 9) 无论成功失败都清理离屏宿主。
    host.remove();
  }
}

/**
 * 文本内容以下载方式保存为文件（默认 Markdown）。触发后延迟释放 ObjectURL。
 */
export function downloadTextAsFile(text: string, filename: string, mime?: string): void {
  const blob = new Blob([text], { type: mime ?? "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟释放：给浏览器留出开始下载的时机。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 解析可下载的 Markdown 原文：
 * - `text`：contentRef 即正文。
 * - `md`/`markdown` 文件：拉取 fileUrl 文本（非 2xx 抛错）。
 * - 其余（pdf/docx/txt…）：`null`（不支持导出）。
 */
export async function resolveMarkdownSource(
  type: "text" | "doc" | "file",
  version: { contentRef: string; fileUrl?: string; fileExt?: string },
): Promise<string | null> {
  if (type === "text") return version.contentRef;
  const ext = (version.fileExt ?? "").toLowerCase();
  if ((ext === "md" || ext === "markdown") && version.fileUrl) {
    const res = await fetch(version.fileUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return null;
}
