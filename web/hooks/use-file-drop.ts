"use client";

/**
 * useFileDrop：窗口级「拖入即上传」交互（文件从 Finder/桌面/其它应用拖进会话窗口）。
 *
 * 用法（容器需 `position: relative`，overlay 由调用方按 dragActive 渲染）：
 * ```tsx
 * const { dragActive, handlers } = useFileDrop((files) => inputRef.current?.addFiles(files));
 * <div style={{ position: "relative" }} {...handlers}>…</div>
 * ```
 *
 * 交互细节（都是真实使用中会踩的点）：
 * - **只用 dragenter/dragleave 计数**：dragenter 会在子元素间反复触发，不计数会出现
 *   「拖到气泡上 overlay 闪一下」；进入 +1、离开 -1，归零才隐藏。
 * - **仅接文件拖拽**：`types` 不含 `Files` 的拖拽（拖选文本/链接）一律不
 *   preventDefault，交还浏览器默认行为，避免破坏 textarea 内拖选文字。
 * - **防止浏览器默认打开文件**：窗口级 `dragover/drop` 对文件拖拽 preventDefault，
 *   避免用户拖偏到页面空白处时浏览器直接导航去打开该文件（丢消息上下文）。
 * - **拖拽取消/失焦复位**：窗口 `dragend` / `blur` / drop 都复位计数，overlay 不会卡住。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { droppedFiles, hasFileDrag } from "@/lib/file-drop";

/** 容器上的四个拖拽事件处理器（直接展开到目标元素）。 */
export interface FileDropHandlers {
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

export interface UseFileDropResult {
  /** 当前是否有文件悬停在拖拽区内（驱动 overlay / 高亮）。 */
  dragActive: boolean;
  handlers: FileDropHandlers;
}

export interface UseFileDropOptions {
  /** 是否在 window 上兜底 preventDefault 文件拖拽（默认 true，防止浏览器打开文件）。 */
  preventWindowNavigation?: boolean;
}

export function useFileDrop(
  onFiles: (files: File[]) => void,
  options: UseFileDropOptions = {},
): UseFileDropResult {
  const { preventWindowNavigation = true } = options;
  const [dragActive, setDragActive] = useState(false);
  /** dragenter/dragleave 嵌套计数（子元素边界会反复触发）。 */
  const depthRef = useRef(0);
  /** 回调存 ref：父组件每次渲染换新函数也不会重挂 window 监听。 */
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setDragActive(false);
  }, []);

  useEffect(() => {
    if (!preventWindowNavigation) return;
    const isFileDrag = (event: DragEvent) => hasFileDrag(event.dataTransfer);
    const handleDragOver = (event: DragEvent) => {
      if (isFileDrag(event)) event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // 拖到拖拽区之外：阻止浏览器「打开文件」默认行为，并复位 overlay
      event.preventDefault();
      reset();
    };
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [preventWindowNavigation, reset]);

  const handlers = useMemo<FileDropHandlers>(
    () => ({
      onDragEnter: (event) => {
        if (!hasFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        depthRef.current += 1;
        setDragActive(true);
      },
      onDragOver: (event) => {
        if (!hasFileDrag(event.dataTransfer)) return;
        // 必须 preventDefault，否则浏览器不会派发 drop
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: () => {
        // 注意：部分浏览器在 dragleave 时 dataTransfer.types 已为空，这里不看类型，
        // 只按计数退场（enter 只对文件拖拽计数，故不会误关普通拖拽的 overlay）。
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setDragActive(false);
      },
      onDrop: (event) => {
        if (!hasFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        const files = droppedFiles(event.dataTransfer);
        reset();
        if (files.length > 0) onFilesRef.current(files);
      },
    }),
    [reset],
  );

  return { dragActive, handlers };
}
