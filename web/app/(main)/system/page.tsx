"use client";

/**
 * 系统管理落地页（trigger-unification Todo 14：薄占位）
 * =============================================
 * Dock「系统管理」（system，/system）的导航目标；users / roles / memories
 * 收敛进本节，子导航壳（Todo 15）与子页面（Todo 16/17）后续在此挂载。
 * 本页仅渲染标题 + 占位说明，不建 sidebar、不搬迁旧页面。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；root flex:1 铺满（AppShell 提供导航）。
 */
import { neutral, space, fontSize, fontFamily } from "@/src/theme/tokens";

export default function SystemPage() {
  return (
    <div
      data-testid="system-manage-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
        overflow: "auto",
        padding: `${space.xl}px ${space.xxl}px`,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <h1
          data-testid="system-manage-title"
          style={{
            fontSize: fontSize.xxl,
            fontWeight: 700,
            color: neutral[900],
            margin: 0,
          }}
        >
          系统管理
        </h1>
        <p
          data-testid="system-manage-hint"
          style={{ fontSize: fontSize.md, color: neutral[500], margin: 0 }}
        >
          平台管理 · 用户账号 · 角色权限 · Agent 记忆（子导航即将上线）
        </p>
      </div>
    </div>
  );
}
