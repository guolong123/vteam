import { test, expect } from "@playwright/test";
import { droppedFiles, hasFileDrag } from "./file-drop";

/**
 * file-drop · 拖拽文件识别纯逻辑门（lib-unit）
 * =============================================
 * 「把文件从 Finder/桌面拖进会话窗口即上传」的判定核心：
 * - 只有 `dataTransfer.types` 含 `"Files"` 才算文件拖拽；拖动选中的文本/链接
 *   （`text/plain` / `text/uri-list`）必须放行给浏览器默认行为，
 *   否则 textarea 里拖选文字会失效（这是本次实现刻意收紧的地方）。
 * - `types` 在不同浏览器可能是数组、DOMStringList 或 Set 形态，
 *   统一按 `ArrayLike` 归一后再判断。
 *
 * 运行：`npx playwright test lib/file-drop.spec.ts --project=lib-unit`
 * 失败语义：改动前本模块不存在 → import 即红。
 */

test("文件拖拽：types 含 Files → true", () => {
  expect(hasFileDrag({ types: ["Files"] })).toBe(true);
  expect(hasFileDrag({ types: ["Files", "text/plain"] })).toBe(true);
  // DOMStringList 形态（真实 DataTransfer 在部分浏览器里就是它）
  expect(hasFileDrag({ types: { 0: "Files", length: 1 } })).toBe(true);
});

test("非文件拖拽：拖动选中的文本/链接不拦截 → false", () => {
  expect(hasFileDrag({ types: ["text/plain"] })).toBe(false);
  expect(hasFileDrag({ types: ["text/uri-list"] })).toBe(false);
  expect(hasFileDrag({ types: [] })).toBe(false);
  expect(hasFileDrag({ types: { length: 0 } })).toBe(false);
});

test("缺省/空 dataTransfer：一律 false（不误触发 overlay）", () => {
  expect(hasFileDrag(null)).toBe(false);
  expect(hasFileDrag(undefined)).toBe(false);
  expect(hasFileDrag({})).toBe(false);
});

test("取拖入文件：保持用户拖入顺序", () => {
  const a = new File(["a"], "需求说明.md", { type: "text/markdown" });
  const b = new File(["b"], "源码.zip", { type: "application/zip" });
  expect(droppedFiles({ files: [a, b] }).map((f) => f.name)).toEqual([
    "需求说明.md",
    "源码.zip",
  ]);
  // ArrayLike（FileList 形态）
  expect(
    droppedFiles({ files: { 0: a, 1: b, length: 2 } }).map((f) => f.name),
  ).toEqual(["需求说明.md", "源码.zip"]);
});

test("取拖入文件：无文件/空列表 → []", () => {
  expect(droppedFiles(null)).toEqual([]);
  expect(droppedFiles({ files: [] })).toEqual([]);
  expect(droppedFiles({})).toEqual([]);
});
