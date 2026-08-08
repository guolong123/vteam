import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import type { CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

/**
 * 原型：登录页（device: both）
 * =====================================================
 * 平台级登录入口：左品牌区（Logo 占位 + 产品名 + 价值主张）+ 右登录表单。
 * - 纯静态展示：不实现登录逻辑 / 路由跳转。
 * - 桌面分栏布局；移动端品牌区折叠为顶栏、表单单列。
 * - 全站浅色主题：品牌区用浅色毛玻璃渐变（白 → neutral[50] → 蓝调点缀），
 *   品牌蓝紫渐变仅保留在 Logo 方块处作点缀，不再大面积深色底。
 * - 关键元素带 data-testid（username / password / login-button / register-link）。
 */

/** 左侧品牌区浅色背景：毛玻璃白底 + 柔和蓝调光晕，与全站 NavDock 浅色主题协调 */
const brandBg =
  "linear-gradient(135deg, rgba(255,255,255,.92) 0%, rgba(248,250,252,.85) 45%, rgba(239,246,255,.9) 100%)";

function BrandPanel({ compact }: { compact: boolean }) {
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: brandBg,
        color: neutral[800],
        ...(compact
          ? {
              width: "100%",
              padding: `${space.md}px ${space.lg}px`,
              flexDirection: "row",
              alignItems: "center",
              borderBottom: `1px solid ${neutral[200]}`,
            }
          : {
              width: 420,
              padding: `${space.xxl}px ${space.xl}px`,
              borderRight: `1px solid ${neutral[200]}`,
            }),
      }}
    >
      {/* Logo 占位 + 产品名 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span
          aria-hidden
          style={{
            width: compact ? 34 : 40,
            height: compact ? 34 : 40,
            borderRadius: radius.md,
            background: "linear-gradient(135deg,#3B82F6,#8B5CF6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: compact ? fontSize.lg : fontSize.xl,
            boxShadow: "0 6px 18px rgba(59,130,246,.3)",
          }}
        >
          A
        </span>
        <div style={{ lineHeight: 1.2 }}>
          <div
            style={{
              fontSize: compact ? fontSize.lg : fontSize.xxl,
              fontWeight: 700,
              color: neutral[900],
              fontFamily: fontFamily.display,
            }}
          >
            Agent 协作平台
          </div>
          {!compact && (
            <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.xs }}>
              让 AI 智能体像真实团队一样协同工作
            </div>
          )}
        </div>
      </div>

      {/* 桌面端价值主张区 */}
      {!compact && (
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, lineHeight: 1.5, color: neutral[800] }}>
            组建虚拟 AI 团队，
            <br />
            从需求到交付全流程协作。
          </div>
          <ul
            style={{
              marginTop: space.lg,
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              listStyle: "none",
              padding: 0,
              fontSize: fontSize.md,
              color: neutral[600],
            }}
          >
            {["任务提交一键组队", "仅被 @ 的 Agent 响应", "产出物沉淀为项目文档"].map((t) => (
              <li key={t} style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span aria-hidden style={{ color: "#3B82F6", fontWeight: 700 }}>✓</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 桌面端底部四角色点缀 */}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.xs, color: neutral[500] }}>
          <span>团队角色</span>
          {(["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B"] as const).map((c) => (
            <span
              key={c}
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: c }}
            />
          ))}
          <span>产品 / 架构 / 开发 / 测试</span>
        </div>
      )}
    </div>
  );
}

function LoginForm() {
  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "#FFFFFF",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 360,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
      }}
    >
      {/* 表单标题 */}
      <div>
        <div style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900], fontFamily: fontFamily.display }}>
          欢迎回来
        </div>
        <div style={{ fontSize: fontSize.md, color: neutral[400], marginTop: space.xs }}>
          登录以进入你的 AI 协作工作区
        </div>
      </div>

      {/* 账号 / 密码 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label
            htmlFor="login-username"
            style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}
          >
            账号
          </label>
          <input
            id="login-username"
            data-testid="username"
            type="text"
            placeholder="请输入账号"
            autoComplete="username"
            aria-label="账号"
            style={inputBase}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label
            htmlFor="login-password"
            style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}
          >
            密码
          </label>
          <input
            id="login-password"
            data-testid="password"
            type="password"
            placeholder="请输入密码"
            autoComplete="current-password"
            aria-label="密码"
            style={inputBase}
          />
        </div>
      </div>

      {/* 登录按钮 */}
      <button
        type="button"
        data-testid="login-button"
        style={{
          width: "100%",
          padding: `${space.md + 2}px ${space.lg}px`,
          borderRadius: radius.md,
          border: "none",
          backgroundColor: "#2563EB",
          color: "#FFFFFF",
          fontSize: fontSize.lg,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 6px 16px rgba(37,99,235,.3)",
          fontFamily: fontFamily.body,
        }}
      >
        登录
      </button>

      {/* 注册入口 */}
      <div style={{ textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
        还没有账号？
        <span
          data-testid="register-link"
          style={{ color: "#2563EB", fontWeight: 500, cursor: "pointer", marginLeft: space.xs }}
        >
          立即注册
        </span>
      </div>
    </div>
  );
}

function LoginPage({ device, deviceWidth }: PrototypeRenderProps) {
  const isMobile = device === "mobile";
  return (
    <div
      style={{
        minHeight: 720,
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        backgroundColor: neutral[50],
        width: deviceWidth,
        fontFamily: fontFamily.body,
      }}
    >
      {/* 移动端：品牌区折叠为顶栏 */}
      {isMobile && <BrandPanel compact />}
      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: `${space.xl}px ${space.lg}px`,
          background: `radial-gradient(90% 60% at 50% 0%, #FFFFFF 0%, ${neutral[50]} 70%)`,
        }}
      >
        <LoginForm />
      </main>
      {/* 桌面端：左侧品牌区 */}
      {!isMobile && <BrandPanel compact={false} />}
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "login",
    name: "登录",
    group: "平台",
    description: "登录页：品牌区 + 账号密码表单 + 注册入口（桌面/移动自适应）",
    device: "both",
  },
  Component: LoginPage,
};

export default def;
