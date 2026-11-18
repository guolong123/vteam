"use client";

/**
 * useSidePanel：侧栏「拖拽调宽 + 收起/展开 + 小屏默认收起」的组合 hook
 * =====================================================================
 * 背景（2026-11-18 用户反馈）：会话页左右两侧面板都是写死宽度（左 300 / 右 300），
 * 小屏上中间聊天区被挤成一条缝；而且没有收起入口，只能被动看着它占位。
 *
 * 职责：
 * - **宽度**：完全复用 `useResizableWidth`（拖拽 + clamp + localStorage 持久化）；
 * - **收起**：独立开关，持久化到 `${storageKey}-collapsed`（"1"/"0"）；
 * - **首屏默认**：没有历史偏好时，视口窄于 `compactBreakpoint` 就默认收起
 *   （宽屏用户看到的是完整布局，窄屏用户先拿到聊天区）；用户手动切过之后
 *   一律以用户选择为准，不再被视口宽度改写（与 docs 页文档树同一套语义）；
 * - **窄屏宽度上限**：宽度再被 `视口 * maxViewportRatio` 封顶，避免在 900px 屏
 *   上把面板拖到 520 后中间区只剩一条缝（拖不动的上限比「拖了再溢出」更可预期）。
 *
 * 注意 SSR：`collapsed` 初值固定 false，首屏判定放在 effect 里，避免水合不一致。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useResizableWidth } from "./use-resizable";

export interface UseSidePanelOptions {
  /** localStorage 持久化键（宽度与收起态都以它为前缀，每面板唯一）。 */
  storageKey: string;
  /** 默认宽度（无持久化值时使用）。 */
  defaultWidth: number;
  min?: number;
  max?: number;
  /** 拖动方向：normal=拖右缘（左面板），inverse=拖左缘（右面板）。 */
  direction?: "normal" | "inverse";
  /** 视口窄于该值且用户没有历史偏好时，首次进入默认收起。默认 1100。 */
  compactBreakpoint?: number;
  /** 宽度不超过视口宽度的比例（默认 0.5），防止窄屏上拖到溢出。 */
  maxViewportRatio?: number;
}

/** 已保存的收起偏好：true/false = 用户选择过；null = 没有偏好。 */
function loadCollapsedPref(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // localStorage 不可用（隐私模式）：按无偏好处理
  }
  return null;
}

function saveCollapsedPref(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, collapsed ? "1" : "0");
  } catch {
    // 仅本次会话生效
  }
}

/**
 * 当前视口宽度。
 * 首帧恒为 Infinity（= 不封顶），与 SSR 输出一致；真实值在水合后的 effect 里补上，
 * 否则「服务端 defaultWidth / 客户端 min(defaultWidth, 视口比例)」会在宽面板上造成水合不一致。
 */
function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function useSidePanel({
  storageKey,
  defaultWidth,
  min = 160,
  max = 480,
  direction = "normal",
  compactBreakpoint = 1100,
  maxViewportRatio = 0.5,
}: UseSidePanelOptions) {
  const resizable = useResizableWidth({
    storageKey,
    defaultWidth,
    min,
    max,
    direction,
  });
  const { nudgeWidth } = resizable;
  const [collapsed, setCollapsed] = useState(false);
  const prefLoadedRef = useRef(false);
  const viewportWidth = useViewportWidth();

  // 首屏默认：有历史偏好 → 用偏好；否则按视口宽度判定（只跑一次）。
  useEffect(() => {
    if (prefLoadedRef.current) return;
    prefLoadedRef.current = true;
    const saved = loadCollapsedPref(`${storageKey}-collapsed`);
    if (saved !== null) {
      setCollapsed(saved);
      return;
    }
    setCollapsed(window.innerWidth < compactBreakpoint);
  }, [storageKey, compactBreakpoint]);

  const setCollapsedPersist = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      saveCollapsedPref(`${storageKey}-collapsed`, next);
    },
    [storageKey],
  );

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsedPref(`${storageKey}-collapsed`, next);
      return next;
    });
  }, [storageKey]);

  const collapse = useCallback(() => setCollapsedPersist(true), [setCollapsedPersist]);
  const expand = useCallback(() => setCollapsedPersist(false), [setCollapsedPersist]);

  /**
   * 键盘调整：方向键语义按面板位置换算。
   * 左面板（normal）向右 = 变宽；右面板（inverse）向左 = 变宽，
   * 所以同一个「ArrowRight」对两块面板的手感是反的，这里统一成「物理方向」。
   */
  const nudge = useCallback(
    (physicalDelta: number) => {
      nudgeWidth(direction === "inverse" ? -physicalDelta : physicalDelta);
    },
    [nudgeWidth, direction],
  );

  /** 实际渲染宽度：拖拽值再按视口比例封顶（窄屏不把中间区挤没）。 */
  const width =
    Number.isFinite(viewportWidth) && viewportWidth > 0
      ? Math.min(resizable.width, Math.round(viewportWidth * maxViewportRatio))
      : resizable.width;

  return {
    width,
    /** 用户拖动后的原始宽度（封顶前的值，调试/断言用）。 */
    rawWidth: resizable.width,
    onResizeStart: resizable.onResizeStart,
    /** 物理方向微调（←/→，正数=向右），供 ResizeHandle 的键盘操作使用。 */
    nudge,
    collapsed,
    toggle,
    collapse,
    expand,
  };
}

export type SidePanelController = ReturnType<typeof useSidePanel>;
