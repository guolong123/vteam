"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * 弹窗焦点陷阱：open 时把焦点移入容器、Tab/Shift+Tab 循环、Esc 关闭、关闭后焦点回到触发器。
 * 返回的 ref 需要挂到弹窗容器上。
 *
 * @param initialFocus - 打开时优先聚焦的选择器（缺省 = 第一个可聚焦元素）。
 *
 * ⚠️ 为什么需要它：缺省行为会聚焦**第一个 input**。对于"展示一段待复制文本"的弹窗，
 * 焦点落在 input 里会让用户按 Ctrl+C 时复制到 **input 自身的选区**（通常是空），
 * 而不是页面上选中的那段文本 ⇒ 表现为"没法复制"。这类弹窗应显式指定聚焦目标
 * （如操作按钮），把焦点留在输入框之外。
 */
export function useFocusTrap<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  initialFocus?: string,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement;

    const el = ref.current;
    if (!el) return;

    // 把焦点移到：显式指定的目标 → autofocus → 第一个可聚焦元素
    const first =
      (initialFocus === undefined ? null : el.querySelector<HTMLElement>(initialFocus)) ??
      el.querySelector<HTMLElement>("[autofocus]") ??
      el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (items.length === 0) return;

      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      // 关闭后焦点回到触发器
      triggerRef.current?.focus();
    };
  }, [open, onClose, initialFocus]);

  return ref;
}
