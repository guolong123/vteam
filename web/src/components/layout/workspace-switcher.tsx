"use client";

/**
 * 工作空间切换器（M3，可搜索下拉面板）。
 *
 * - 系统空间（isSystem=true）不作为可切换工作空间，仅提示「平台资源只读」；
 * - 点击展开搜索面板，可按空间名 / id 过滤（空间多时不再受原生 select 限制）；
 * - 切换 = 调 authStore.switchWorkspace（后端重签 token 并更新当前空间）；
 * - 调用方（AppShell）负责清 react-query 缓存 + 刷新路由数据。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  neutral,
  radius,
  space,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import type { WorkspaceSummary } from "@/lib/stores/authStore";

export interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummary[];
  currentWorkspaceId?: string | null;
  switching?: boolean;
  onSwitch: (workspaceId: string) => void;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "空间所有者",
  admin: "空间管理员",
  member: "空间成员",
};

const labelStyle: CSSProperties = {
  fontSize: fontSize.xs,
  color: neutral[500],
  fontFamily: fontFamily.body,
  whiteSpace: "nowrap",
};

export function WorkspaceSwitcher({
  workspaces,
  currentWorkspaceId,
  switching = false,
  onSwitch,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const switchable = useMemo(
    () => workspaces.filter((w) => !w.isSystem),
    [workspaces],
  );
  const current =
    switchable.find((w) => w.id === currentWorkspaceId) ?? switchable[0];
  const hasSystem = workspaces.some((w) => w.isSystem);

  // 点击面板外 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return switchable;
    return switchable.filter(
      (w) =>
        w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q),
    );
  }, [switchable, query]);

  if (switchable.length === 0) return null;

  // 只有一个可切换空间：只显示当前空间名（不渲染无意义的下拉）
  if (switchable.length === 1) {
    return (
      <span
        data-testid="workspace-current"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          maxWidth: 240,
        }}
        title={current?.name}
      >
        <span style={labelStyle}>空间</span>
        <span
          style={{
            fontSize: fontSize.sm,
            color: neutral[800],
            fontFamily: fontFamily.body,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {current?.name ?? "默认空间"}
        </span>
      </span>
    );
  }

  return (
    <div ref={rootRef} data-testid="workspace-switcher" style={{ position: "relative" }}>
      <button
        type="button"
        data-testid="workspace-switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        title="切换工作空间（数据、模型、Worker、成员均按空间隔离）"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: radius.md,
          border: `1px solid ${open ? "rgba(13,148,136,.45)" : neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          cursor: switching ? "wait" : "pointer",
          maxWidth: 280,
          fontFamily: fontFamily.body,
        }}
      >
        <span style={labelStyle}>空间</span>
        <span
          style={{
            fontSize: fontSize.sm,
            color: neutral[800],
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {switching ? "切换中…" : (current?.name ?? "选择空间")}
        </span>
        {current?.role ? (
          <span style={labelStyle}>({ROLE_LABEL[current.role] ?? current.role})</span>
        ) : null}
        <span aria-hidden style={{ ...labelStyle, fontSize: fontSize.xs, marginLeft: 2 }}>
          ▾
        </span>
      </button>

      {open ? (
        <div
          data-testid="workspace-switcher-panel"
          role="listbox"
          aria-label="工作空间列表"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 80,
            width: 300,
            padding: space.sm,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            boxShadow: shadow.lg,
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
          }}
        >
          <input
            data-testid="workspace-switcher-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索空间名称 / id"
            style={{
              padding: `${space.xs + 2}px ${space.sm}px`,
              borderRadius: radius.sm,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[800],
              fontSize: fontSize.sm,
              fontFamily: fontFamily.body,
              outline: "none",
            }}
          />
          <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.map((w) => {
              const isCurrent = w.id === current?.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-testid={`workspace-switcher-option-${w.id}`}
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    if (!isCurrent) onSwitch(w.id);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.sm}px`,
                    borderRadius: radius.sm,
                    border: "none",
                    backgroundColor: isCurrent ? "rgba(13,148,136,.08)" : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: fontFamily.body,
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                      borderRadius: radius.sm,
                      backgroundColor: "#0D9488",
                      color: "#FFFFFF",
                      fontSize: fontSize.xs,
                      fontWeight: 700,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    aria-hidden
                  >
                    {w.name.slice(0, 1)}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        fontSize: fontSize.sm,
                        fontWeight: isCurrent ? 600 : 500,
                        color: neutral[800],
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {w.name}
                    </span>
                    <span style={{ ...labelStyle, fontSize: 10 }}>
                      {w.id}
                    </span>
                  </span>
                  {isCurrent ? (
                    <span style={{ ...labelStyle, color: "#0F766E", fontWeight: 600 }}>✓</span>
                  ) : w.role ? (
                    <span style={labelStyle}>{ROLE_LABEL[w.role] ?? w.role}</span>
                  ) : null}
                </button>
              );
            })}
            {filtered.length === 0 ? (
              <span style={{ ...labelStyle, padding: space.sm }}>无匹配空间</span>
            ) : null}
          </div>
          {hasSystem ? (
            <span
              data-testid="workspace-system-hint"
              style={{
                ...labelStyle,
                fontSize: 10,
                color: neutral[400],
                borderTop: `1px solid ${neutral[100]}`,
                paddingTop: space.xs,
              }}
            >
              平台资源（内置 Agent 模板 / 技能 / 工具 / 模型目录）所有空间只读共享
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
