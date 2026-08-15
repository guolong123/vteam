"use client";

/**
 * useResizableWidth：面板宽度拖拽调整 hook（is_0000000017）
 * =============================================================
 * - 拖动侧边（handle）调整面板宽度，方向由 direction 决定：
 *   · 'normal'：拖面板右缘 → 右移增大宽度（左侧面板）
 *   · 'inverse'：拖面板左缘 → 右移减小宽度（右侧面板）
 * - 宽度 clamp 在 [min, max]，避免过窄/过宽；
 * - 宽度持久化到 localStorage（storageKey 隔离会话/页面），刷新保持；
 * - 返回 { width, onResizeStart }，handle 为竖直细条（cursor col-resize）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseResizableOptions {
  /** localStorage 持久化键（每面板唯一，如 "task-members-panel-width"）。 */
  storageKey: string;
  /** 默认宽度（无持久化值时使用）。 */
  defaultWidth: number;
  min?: number;
  max?: number;
  /** 拖动方向：normal=拖右缘（左面板），inverse=拖左缘（右面板）。 */
  direction?: "normal" | "inverse";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 从 localStorage 读持久化宽度（非法/缺失 → 缺省值）。 */
function loadWidth(storageKey: string, defaultWidth: number): number {
  if (typeof window === "undefined") return defaultWidth;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return defaultWidth;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : defaultWidth;
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min = 160,
  max = 480,
  direction = "normal",
}: UseResizableOptions) {
  const [width, setWidth] = useState<number>(() =>
    loadWidth(storageKey, defaultWidth),
  );
  const sessionRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  /** 拖动开始：记录起始位置 + 当前宽度，挂载全局 move/up 监听。 */
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sessionRef.current = { startX: e.clientX, startWidth: widthRef.current };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (ev: MouseEvent) => {
        const s = sessionRef.current;
        if (!s) return;
        const delta = ev.clientX - s.startX;
        const next =
          direction === "inverse"
            ? s.startWidth - delta
            : s.startWidth + delta;
        setWidth(clamp(next, min, max));
      };

      const handleUp = () => {
        sessionRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        // 结束即持久化（取 ref 最新值，避免闭包过期）
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current));
        } catch {
          // 忽略 localStorage 不可用（隐私模式等）
        }
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [storageKey, direction, min, max],
  );

  // 组件卸载兜底清理（避免 handleUp 未触发时监听泄漏）
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current));
        } catch {
          // ignore
        }
      }
    };
  }, [storageKey]);

  return { width, onResizeStart };
}
