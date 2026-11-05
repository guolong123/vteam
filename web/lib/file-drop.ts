/**
 * 文件拖拽识别纯逻辑（`use-file-drop` 的测试缝，lib-unit 可独立测）。
 *
 * 为什么单列一层：真正的 DragEvent/DataTransfer 只有浏览器里才有，纯函数抽出来后
 * 可以在 Node 侧用一个 `{ types: string[] }` 形状的对象直接断言，不必起浏览器。
 *
 * 判定规则（刻意收紧，避免误吞普通拖拽）：
 * - 只有 `dataTransfer.types` 里出现 `"Files"` 才算「拖动文件」——拖动选中的文本、
 *   链接、页面内元素时 types 是 `text/plain` / `text/uri-list` 等，必须放行给浏览器
 *   默认行为（否则 textarea 里拖选文字会失效）；
 * - 有些环境 `types` 是 DOMStringList（不可直接 `.includes`），统一 `Array.from` 归一。
 */

/** 一次 `dataTransfer` 是否携带文件（区分拖动文本/链接）。 */
export function hasFileDrag(
  dataTransfer: { types?: ArrayLike<string> | null } | null | undefined,
): boolean {
  if (!dataTransfer?.types) return false;
  for (const type of Array.from(dataTransfer.types)) {
    if (type === "Files") return true;
  }
  return false;
}

/** 从 `dataTransfer.files` 取文件数组（无文件 → `[]`；保持用户拖入顺序）。 */
export function droppedFiles(
  dataTransfer: { files?: ArrayLike<File> | null } | null | undefined,
): File[] {
  if (!dataTransfer?.files) return [];
  return Array.from(dataTransfer.files);
}
