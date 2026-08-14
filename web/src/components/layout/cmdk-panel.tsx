"use client";

/**
 * CmdKPanel：Cmd+K 命令面板浮层（居中毛玻璃 + 遮罩，受控开关）
 *
 * 从 docs/agent-platform/prototypes/_shared/nav.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 * 受控开关：open 默认 false，父级 useState 管理；onClose 关闭（✕ / 遮罩 / Esc）。
 * 宿主容器需 position: relative。
 */
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 导航语义常量 ------------------------------ */
const NAV_ACTIVE = "#3B82F6";
const NAV_ACTIVE_DEEP = "#2563EB";

export interface CmdKItem {
  group: string;
  label: string;
  icon: string;
  /** 是否高亮（模拟键盘选中态） */
  active?: boolean;
}

export interface CmdKPanelProps {
  /** 是否展示（默认 false，受控开关；由父级 useState 管理） */
  open?: boolean;
  /** 关闭回调（✕ 按钮 / 遮罩点击 / Esc 键触发） */
  onClose?: () => void;
  /** 命令项（默认提供「导航 / 操作」两组，导航 7 条与 Dock 图标对应） */
  items?: CmdKItem[];
  /** 点击命令项回调 */
  onSelect?: (label: string) => void;
  /** 底部提示区扩展插槽 */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export const DEFAULT_CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "Issue 管理", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "模型管理", icon: "◇" },
  { group: "导航", label: "仓库管理", icon: "⌗" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "导航", label: "用户管理", icon: "☷" },
  { group: "导航", label: "角色权限", icon: "⚖" },
  { group: "操作", label: "新建任务", icon: "＋" },
];

const navAnimStyle = `
  @keyframes navshared-blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes navshared-pop { from{opacity:0; transform:translateY(8px) scale(.985)} to{opacity:1; transform:none} }
  @keyframes navshared-fade { from{opacity:0} to{opacity:1} }
`;

const panelCss = navAnimStyle + `
.navcmdk-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12%;
}
.navcmdk-mask {
  position: absolute;
  inset: 0;
  background-color: rgba(15,23,42,.32);
  animation: navshared-fade .18s ease-out;
}
.navcmdk-panel {
  position: relative;
  width: 600px;
  max-width: calc(100% - 48px);
  max-height: min(560px, 74%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: ${radius.lg}px;
  background-color: rgba(255,255,255,.84);
  backdrop-filter: blur(20px) saturate(1.5);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid rgba(255,255,255,.72);
  box-shadow: ${shadow.lg};
  animation: navshared-pop .16s ease-out;
}
.navcmdk-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${space.md}px;
  padding: ${space.sm + 2}px ${space.md}px;
  border-radius: ${radius.md}px;
  border: none;
  cursor: pointer;
  text-align: left;
  background: transparent;
  color: ${neutral[700]};
  font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.navcmdk-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.navcmdk-item[data-active="true"] { background: ${NAV_ACTIVE_DEEP}; color: #FFFFFF; }
.navcmdk-item-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: ${radius.sm}px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: ${fontSize.lg}px;
  line-height: 1;
  background-color: ${neutral[100]};
  color: ${NAV_ACTIVE};
}
.navcmdk-item[data-active="true"] .navcmdk-item-icon { background: rgba(255,255,255,.18); color: #FFFFFF; }
.navcmdk-item-label {
  flex: 1;
  min-width: 0;
  font-size: ${fontSize.md}px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.navcmdk-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  margin-left: ${space.xs}px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: transparent;
  color: ${neutral[400]};
  font-size: ${fontSize.lg}px;
  line-height: 1;
  transition: background-color .15s ease, color .15s ease;
}
.navcmdk-close:hover { background-color: ${neutral[100]}; color: ${neutral[900]}; }
`;

export function CmdKPanel({
  open = false,
  items = DEFAULT_CMDK_ITEMS,
  onSelect,
  onClose,
  children,
  style,
  className,
}: CmdKPanelProps) {
  // 搜索关键词（受控）：输入后按 label/group 过滤，清空恢复全部
  const [query, setQuery] = useState("");

  // 重新打开时重置搜索词：面板每次打开都展示全部命令
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Esc 键关闭：open 时才挂监听，卸载/关闭时清理
  useEffect(() => {
    if (!open || !onClose) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // 过滤：大小写不敏感，按 label/group includes 匹配；空串时保留全部
  const q = query.trim().toLowerCase();
  const filteredItems = items.filter(
    (item) =>
      !q ||
      item.label.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q),
  );

  // 按 group 保序分组
  const groups: { group: string; items: CmdKItem[] }[] = [];
  for (const item of filteredItems) {
    const g = groups.find((x) => x.group === item.group);
    if (g) g.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }

  return (
    <div
      data-testid="cmdk-panel"
      className={`navcmdk-overlay${className ? ` ${className}` : ""}`}
      style={baseFont}
    >
      <style>{panelCss}</style>
      {/* 轻遮罩：主体内容仍然可辨，点击关闭 */}
      <div aria-hidden className="navcmdk-mask" onClick={onClose} />

      {/* 面板：毛玻璃 + 圆角 + 阴影 */}
      <div className="navcmdk-panel" style={style}>
        {/* 搜索输入（光标闪烁模拟聚焦态） */}
        <div
          data-testid="cmdk-search"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
          }}
        >
          <span aria-hidden style={{ fontSize: 18, color: neutral[400], lineHeight: 1 }}>
            ⌕
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索或输入命令…"
            aria-label="搜索命令"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: fontSize.xl,
              fontWeight: 500,
              color: neutral[900],
              fontFamily: fontFamily.body,
              padding: 0,
            }}
          />
          {/* 模拟光标：输入非空时隐藏，避免与真实光标双闪烁 */}
          {query.length === 0 && (
            <span
              aria-hidden
              style={{
                width: 2,
                height: 18,
                flexShrink: 0,
                borderRadius: 1,
                backgroundColor: NAV_ACTIVE_DEEP,
                animation: "navshared-blink 1.05s step-end infinite",
              }}
            />
          )}
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.sm,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            ESC
          </span>
          {/* 关闭按钮：右上角 ✕（圆形 hover） */}
          <button
            type="button"
            data-testid="cmdk-close"
            aria-label="关闭命令面板"
            className="navcmdk-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* 命令分组列表 */}
        <div style={{ flex: 1, overflow: "auto", padding: space.sm }}>
          {groups.length === 0 ? (
            <div
              style={{
                padding: `${space.sm + 2}px ${space.md}px`,
                fontSize: fontSize.md,
                color: neutral[400],
                textAlign: "center",
              }}
            >
              无匹配命令
            </div>
          ) : (
            groups.map((g) => (
            <div key={g.group}>
              <div
                style={{
                  padding: `${space.sm}px ${space.md}px ${space.xs}px`,
                  fontSize: fontSize.xs,
                  fontWeight: 600,
                  color: neutral[400],
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {g.group}
              </div>
              {g.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  data-testid="cmdk-item"
                  data-active={item.active ? "true" : "false"}
                  className="navcmdk-item"
                  onClick={onSelect ? () => onSelect(item.label) : undefined}
                >
                  <span className="navcmdk-item-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="navcmdk-item-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))
          )}
        </div>

        {/* 底部提示（children 可覆盖） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.lg,
            padding: `${space.sm}px ${space.lg}px`,
            borderTop: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          {children ?? (
            <>
              <span>↑↓ 选择</span>
              <span>↵ 打开</span>
              <span>⌘K 唤起</span>
              <span style={{ marginLeft: "auto" }}>Dock 常驻 · ⌘K 全览</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}