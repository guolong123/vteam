/**
 * MessageNavigator：会话消息的右侧悬浮快速定位条
 * =============================================
 * 长会话（成员视角动辄几十轮、上百条消息）里，用户想回到「某次派发/某条结论」只能靠滚轮盲找。
 * 本组件在消息列表右侧画一条**位置刻度轨**：
 *
 * - 每个锚点 = 一条消息，纵向位置按其在内容里的真实偏移等比映射；
 * - **hover 刻度** → 浮出该消息的摘要卡片（谁说的 + 前若干字）；
 * - **点击刻度** → 平滑滚动到该消息；
 * - 轨道上高亮「当前视口所在」的消息，滚动时实时更新。
 *
 * 实现要点（为什么这么做）：
 * 1. 位置用 `getBoundingClientRect` + `scrollTop` 实时量取，而不是假设等距 ——
 *    消息高度差异极大（一句结论 vs 一屏工具输出），等距刻度会指错位置。
 * 2. 监听容器 scroll / resize 与内容变化（ResizeObserver），否则图片/代码块
 *    异步撑高后刻度会漂移。
 * 3. 刻度只渲染可见范围（曜点数量上限 MAX_MARKS），避免上千条消息时 DOM 爆炸。
 *
 * @module components/chat/message-navigator
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fontSize, neutral, radius, shadow, space } from "@/src/theme/tokens";

export interface MessageNavAnchor {
  /** 消息 id（对应 DOM 上的 `data-msg-nav-id`）。 */
  id: string;
  /** 摘要文本（hover 卡片展示）。 */
  label: string;
  /** 作者展示名（空 = 用户自己）。 */
  author?: string;
  /** 角色：用于刻度配色（user 锚点更醒目）。 */
  role: "user" | "agent" | "system" | "external";
}

export interface MessageNavigatorProps {
  /** 消息列表滚动容器。 */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  anchors: MessageNavAnchor[];
  /** 依赖项：消息数量/内容变化时触发重新量取。 */
  measureKey?: unknown;
}

/** 刻度数量上限（超出则按比例抽样，保证轨道可读且 DOM 不爆）。 */
const MAX_MARKS = 120;

interface Mark {
  id: string;
  /** 0..1 的纵向比例。 */
  ratio: number;
  role: MessageNavAnchor["role"];
}

const ROLE_COLOR: Record<MessageNavAnchor["role"], string> = {
  user: "#0F766E",
  agent: "#94A3B8",
  system: "#CBD5E1",
  external: "#A78BFA",
};

export function MessageNavigator({ scrollRef, anchors, measureKey }: MessageNavigatorProps) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  /**
   * 浏览器滚动条宽度：导航轨道必须**让开它**，否则刻度和滚动条叠在一起
   * （用户实测：「这个滚动条和刻度放一起了」）。
   * macOS 的 overlay 滚动条宽度为 0，Windows/Linux 通常 15~17px，
   * 所以动态量 `offsetWidth - clientWidth` 而不是写死。
   */
  const [scrollbarWidth, setScrollbarWidth] = useState(0);

  const anchorById = useMemo(() => {
    const m = new Map<string, MessageNavAnchor>();
    for (const a of anchors) m.set(a.id, a);
    return m;
  }, [anchors]);

  /** 量取每条锚点消息在内容里的纵向比例。 */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || anchors.length === 0) {
      setMarks([]);
      return;
    }
    const containerRect = el.getBoundingClientRect();
    const scrollOffset = el.scrollTop;
    const total = el.scrollHeight || 1;
    const raw: Mark[] = [];
    for (const a of anchors) {
      const node = el.querySelector<HTMLElement>(
        `[data-msg-nav-id="${a.id}"]`,
      );
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const top = rect.top - containerRect.top + scrollOffset;
      raw.push({
        id: a.id,
        ratio: Math.min(1, Math.max(0, top / total)),
        role: a.role,
      });
    }
    // 超出上限按比例抽样（保留首尾与均匀分布，避免密集区糊成一条）
    if (raw.length > MAX_MARKS) {
      const step = raw.length / MAX_MARKS;
      const sampled: Mark[] = [];
      for (let i = 0; i < MAX_MARKS; i += 1) {
        const m = raw[Math.min(raw.length - 1, Math.round(i * step))];
        if (m && sampled[sampled.length - 1]?.id !== m.id) sampled.push(m);
      }
      setMarks(sampled);
    } else {
      setMarks(raw);
    }
  }, [anchors, scrollRef]);

  /** 更新「当前视口所在消息」（取视口上方第一条可见锚点）。 */
  const updateActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el || anchors.length === 0) return;
    const probe = el.getBoundingClientRect().top + 64;
    let current: string | null = null;
    for (const a of anchors) {
      const node = el.querySelector<HTMLElement>(`[data-msg-nav-id="${a.id}"]`);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= probe) current = a.id;
      else break;
    }
    setActiveId(current);
  }, [anchors, scrollRef]);

  useEffect(() => {
    measure();
    updateActive();
  }, [measure, updateActive, measureKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const calc = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updateActive();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(el);
    // 内容异步撑高（图片、代码块、流式追加）也要重算
    const mo = new MutationObserver(() => measure());
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollRef, measure, updateActive]);

  const jumpTo = useCallback(
    (id: string) => {
      const el = scrollRef.current;
      const node = el?.querySelector<HTMLElement>(`[data-msg-nav-id="${id}"]`);
      if (!el || !node) return;
      const top =
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        24;
      el.scrollTo({ top, behavior: "smooth" });
      setActiveId(id);
    },
    [scrollRef],
  );

  if (anchors.length < 6) return null;

  const hovered = hoveredId ? anchorById.get(hoveredId) : null;
  /**
   * 集中轨道参数（DSH 风格）。
   *
   * 原本按消息真实位置把刻度铺满整个高度 ⇒ 稀疏分散、且间距随内容高度剧烈变化，
   * 视觉上不像「导航条」而像随机噪点（用户反馈）。改成：
   * - 轨道**固定高度**（不超过 340px），垂直居中；
   * - 刻度在轨道内**等距密排**（步长 8px，条数多时自动压缩到 4px）；
   * - 命中区放大到 10px，视觉刻度保持 2px —— 既要好点，又不能显笨重。
   */
  const hoverIndex = hoveredId
    ? marks.findIndex((m) => m.id === hoveredId)
    : -1;
  const trackHeight = Math.min(340, Math.max(80, marks.length * 8));
  const gap =
    marks.length > 1
      ? Math.min(8, Math.max(4, (trackHeight - 10) / (marks.length - 1)))
      : 8;
  /** 预览卡片跟随 hover 刻度的纵向位置（并夹在轨道范围内）。 */
  const hoverPreviewTop =
    hoverIndex >= 0 ? Math.max(40, Math.min(trackHeight - 40, hoverIndex * gap)) : 0;

  return (
    <div
      data-testid="message-navigator"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => {
        setVisible(false);
        setHoveredId(null);
      }}
      style={{
        position: "absolute",
        // 集中居中：轨道只占中间一段高度（DSH 风格），不再撑满整列
        top: "50%",
        transform: "translateY(-50%)",
        height: trackHeight,
        /**
         * 让开浏览器滚动条（+6px 视觉间距）。
         * 取 `max(scrollbarWidth, 12)`：macOS 的 overlay 滚动条量出来是 0，
         * 但用户接了鼠标/系统设了「始终显示滚动条」时仍会占 15px ——
         * 保底 12px 偏移保证任何平台轨道都不会压在滚动条上。
         */
        right: Math.max(scrollbarWidth, 12) + 6,
        // 容器加宽到 22px：刻度本身仍细，但整条轨道是更大的 hover 命中面
        // （用户反馈「太窄很难选中」）
        width: 22,
        zIndex: 20,
      }}
    >
      {/* 轨道 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: 2,
          transform: "translateX(-50%)",
          borderRadius: 1,
          backgroundColor: neutral[100],
          opacity: visible ? 1 : 0.55,
          transition: "opacity 120ms ease",
        }}
      />
      {marks.map((m, i) => {
        const isActive = m.id === activeId;
        const isHovered = m.id === hoveredId;
        return (
          <button
            key={m.id}
            type="button"
            data-testid="message-nav-mark"
            data-role={m.role}
            aria-label={anchorById.get(m.id)?.label ?? ""}
            onMouseEnter={() => {
              if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
              hoverTimer.current = window.setTimeout(
                () => setHoveredId(m.id),
                60,
              );
            }}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => jumpTo(m.id)}
            style={{
              position: "absolute",
              // 等距密排（DSH 风格）：不再按真实位置分散，而是集中在轨道内均匀铺开，
              // 每 8px 一个刻度；真实位置仅用于 scrollIntoView 跳转。
              top: i * gap,
              left: 0,
              width: "100%",
              // 命中区刻意放大到 10px（视觉刻度仍细），否则鼠标很难对准（用户实测）
              height: 10,
              border: "none",
              padding: 0,
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                width: isHovered || isActive ? 14 : 9,
                height: 2,
                borderRadius: 1,
                backgroundColor: ROLE_COLOR[m.role],
                opacity: isActive || isHovered ? 1 : 0.75,
                transition: "width 100ms ease, opacity 100ms ease",
              }}
            />
          </button>
        );
      })}

      {/* hover 预览卡片 */}
      {hovered && (
        <div
          data-testid="message-nav-preview"
          style={{
            position: "absolute",
            right: 24,
            top: hoverPreviewTop,
            transform: "translateY(-50%)",
            width: 260,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "var(--color-surface)",
            border: `1px solid ${neutral[200]}`,
            boxShadow: shadow.md,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            pointerEvents: "none",
          }}
        >
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {hovered.author || "我"}
          </span>
          <span
            style={{
              fontSize: fontSize.sm,
              color: neutral[700],
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {hovered.label}
          </span>
        </div>
      )}
    </div>
  );
}
