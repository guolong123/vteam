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
 *
 * 指针事件（2026-11-18）：`onResizeStart` 同时接受 PointerEvent 与 MouseEvent。
 * 小屏笔记本/平板以触屏为主，旧实现只挂 mousedown → 手指拖不动分隔条；
 * 传 PointerEvent（pointerId 存在）时改挂 pointermove/pointerup，鼠标路径保持原样
 * （两条路径不并存，避免同一次拖拽被算两次 delta）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 拖拽起始事件：PointerEvent 走触摸/笔/鼠标统一路径，MouseEvent 兼容旧调用方。 */
export type ResizeStartEvent = React.PointerEvent | React.MouseEvent;

/**
 * SSR 安全的首帧宽度：**必须**返回 defaultWidth 而不是 localStorage 里的值。
 *
 * 旧实现在 useState 初始化函数里直接读 localStorage，服务端渲染时读不到（返回默认值），
 * 客户端水合时读到持久化值 → 两棵树宽度不一致，React 保留服务端的 300px，
 * 于是「拖宽后刷新」看起来像没保存（实测：localStorage=390、渲染宽度=300）。
 * 现在持久化值统一在水合后的 layout effect 里补上（见下方 useEffect 块），
 * 首帧默认宽 → 同一帧内改写，视觉上不闪。
 */
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
  // 首帧恒为 defaultWidth（SSR 与客户端一致），持久化值在水合后补上（见下方 hydration effect）
  const [width, setWidth] = useState<number>(defaultWidth);
  const sessionRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  /**
   * 水合后恢复持久化宽度。
   * 用 layout effect：在浏览器绘制前完成，避免「默认宽 → 恢复宽」的可见跳动。
   * storageKey 变化（同一组件换面板）时重新读取。
   */
  useLayoutEffect(() => {
    const next = loadWidth(storageKey, defaultWidth);
    setWidth(clamp(next, min, max));
    widthRef.current = clamp(next, min, max);
  }, [storageKey, defaultWidth, min, max]);

  /** 拖动开始：记录起始位置 + 当前宽度，挂载全局 move/up 监听。 */
  const onResizeStart = useCallback(
    (e: ResizeStartEvent) => {
      e.preventDefault();
      sessionRef.current = { startX: e.clientX, startWidth: widthRef.current };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      /** 指针事件路径才有 pointerId；没有则按鼠标事件处理。 */
      const pointerId =
        typeof (e as React.PointerEvent).pointerId === "number"
          ? (e as React.PointerEvent).pointerId
          : null;
      const isPointer = pointerId !== null;
      const moveEvent = isPointer ? "pointermove" : "mousemove";
      const upEvent = isPointer ? "pointerup" : "mouseup";

      const handleMove = (ev: MouseEvent | PointerEvent) => {
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
        window.removeEventListener(moveEvent, handleMove as EventListener);
        window.removeEventListener(upEvent, handleUp);
        // 结束即持久化（取 ref 最新值，避免闭包过期）
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current));
        } catch {
          // 忽略 localStorage 不可用（隐私模式等）
        }
      };

      window.addEventListener(moveEvent, handleMove as EventListener);
      window.addEventListener(upEvent, handleUp);
      // 触摸拖拽：阻止浏览器把横向拖动当成页面滚动/回弹
      window.addEventListener("touchmove", preventTouchScroll, { passive: false });
      window.addEventListener("touchend", stopTouchBlock);

      function preventTouchScroll(ev: TouchEvent) {
        if (sessionRef.current) ev.preventDefault();
      }
      function stopTouchBlock() {
        window.removeEventListener("touchmove", preventTouchScroll);
        window.removeEventListener("touchend", stopTouchBlock);
      }
    },
    [storageKey, direction, min, max],
  );

  /** 键盘/按钮微调：在当前宽度上加减 delta（clamp 后立即持久化）。 */
  const nudgeWidth = useCallback(
    (delta: number) => {
      setWidth((prev) => {
        const next = clamp(prev + delta, min, max);
        try {
          window.localStorage.setItem(storageKey, String(next));
        } catch {
          // ignore
        }
        widthRef.current = next;
        return next;
      });
    },
    [storageKey, min, max],
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

  return { width, onResizeStart, nudgeWidth };
}
