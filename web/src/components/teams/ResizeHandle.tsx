"use client";
/**
 * 面板拖拽分隔条（共享）：成员面板 / 任务面板 / 会话页左右栏宽度拖拽。
 *
 * 小屏（2026-11-18）：
 * - 命中区从 6px 放宽到 9px（手指也能抓住），视觉细线仍是 3px 居中；
 * - 用 Pointer 事件（touch-action: none），触屏/手写笔同样可拖；
 * - 键盘可达：左右方向键 ±16px（Shift ±64px），role=separator + aria-valuenow。
 */
import React from "react";
import type { ResizeStartEvent } from "@/src/hooks/use-resizable";

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export function ResizeHandle({
  label,
  onResizeStart,
  width,
  onKeyResize,
}: {
  label: string;
  onResizeStart: (e: ResizeStartEvent) => void;
  /** 当前面板宽度（仅用于 aria-valuenow，缺省不输出）。 */
  width?: number;
  /** 键盘调整（方向键 ±16 / Shift ±64，单位 px；正数=变宽）。 */
  onKeyResize?: (delta: number) => void;
}) {
  const [hover, setHover] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const active = hover || dragging;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={160}
      aria-valuemax={undefined}
      tabIndex={onKeyResize ? 0 : -1}
      data-testid="panel-resize-handle"
      title={onKeyResize ? `${label}（拖动或 ←/→ 调整）` : label}
      onPointerDown={(e) => {
        setDragging(true);
        onResizeStart(e);
        // 拖拽指针捕获：手指滑出细条也不丢事件
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onMouseDown={(e) => {
        // Pointer 事件已覆盖时不再重复启动（浏览器在 pointerdown 后仍会派发 mousedown）
        if (e.button !== 0) return;
        if (typeof window !== "undefined" && "onpointerdown" in window) return;
        setDragging(true);
        onResizeStart(e);
      }}
      onMouseUp={() => setDragging(false)}
      onKeyDown={(e) => {
        if (!onKeyResize) return;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        onKeyResize(e.key === "ArrowRight" ? step : -step);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0,
        width: 9,
        // 左右各 3px 视觉留给热区，中间细线在 hover/拖拽时高亮
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        cursor: "col-resize",
        touchAction: "none",
        backgroundColor: "transparent",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 3,
          height: "100%",
          borderRadius: 2,
          backgroundColor: active ? "rgba(13,148,136,0.42)" : "transparent",
          transition: "background-color .15s ease",
        }}
      />
    </div>
  );
}
