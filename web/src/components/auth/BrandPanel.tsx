"use client";

/**
 * 认证页共享品牌区（登录 / 注册共用，Task 11 原型保真迁移）
 * =========================================================
 * 平台级左品牌区（Logo 占位 + 产品名 + 价值主张）+ 移动端折叠顶栏。
 * 自 web/app/login/page.tsx 提取（ISSUE-011 注册页复用），文案/样式零改动。
 * - 桌面分栏布局：品牌区 33.33% 宽，右表单区由页面自行渲染。
 * - 移动端：品牌区折叠为顶栏（width 100% + row 布局），页面据此渲染单列表单。
 */
import { useEffect, useState, type CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

/** 页面级渐变背景（跟随主题：浅色白→灰→蓝，深色深灰→墨蓝） */
export const pageBg =
  "linear-gradient(160deg, var(--color-surface) 0%, var(--color-bg) 50%, var(--color-bg) 100%)";

/** 品牌区渐变（跟随主题） */
const brandBg =
  "linear-gradient(160deg, var(--color-surface) 0%, var(--color-bg) 55%, var(--color-bg) 100%)";

/** 品牌区文字/边框（跟随主题，浅底深字→深底浅字） */
const brandOnDark = {
  glow: "radial-gradient(70% 55% at 15% 85%, rgba(59,130,246,.1), transparent 70%)",
  text: "var(--color-neutral-900)",
  textStrong: "var(--color-neutral-800)",
  textSub: "var(--color-neutral-500)",
  textMuted: "var(--color-neutral-400)",
  textList: "var(--color-neutral-600)",
  border: "var(--color-neutral-200)",
  accent: "#3B82F6",
} as const;

/** 移动端检测：< breakpoint 视为 mobile（品牌区折叠为顶栏） */
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}

export function BrandPanel({ compact }: { compact: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        flexShrink: 0,
        display: "flex",
        justifyContent: "space-between",
        background: `${brandOnDark.glow}, ${brandBg}`,
        color: brandOnDark.text,
        ...(compact
          ? {
              width: "100%",
              padding: `${space.md}px ${space.lg}px`,
              flexDirection: "row",
              alignItems: "center",
              borderBottom: `1px solid ${brandOnDark.border}`,
            }
          : {
              width: "33.33%",
              padding: `${space.xxl}px ${space.xl}px`,
              flexDirection: "column",
              justifyContent: "space-between",
              gap: space.xl * 2,
              borderRight: `1px solid ${brandOnDark.border}`,
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
            boxShadow: "0 8px 24px rgba(59,130,246,.35)",
          }}
        >
          A
        </span>
        <div style={{ lineHeight: 1.2 }}>
          <div
            style={{
              fontSize: compact ? fontSize.lg : fontSize.xxl,
              fontWeight: 700,
              color: brandOnDark.text,
              fontFamily: fontFamily.display,
            }}
          >
            Agent 协作平台
          </div>
          {!compact && (
            <div
              style={{
                fontSize: fontSize.xs,
                color: brandOnDark.textSub,
                marginTop: space.xs,
              }}
            >
              让 AI 智能体像真实团队一样协同工作
            </div>
          )}
        </div>
      </div>

      {/* 桌面端价值主张区 */}
      {!compact && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xl * 2,
          }}
        >
          <div>
            <div
              style={{
                fontSize: fontSize.xl,
                fontWeight: 600,
                lineHeight: 1.5,
                color: brandOnDark.textStrong,
              }}
            >
              组建虚拟 AI 团队，
              <br />
              从需求到交付全流程协作。
            </div>
            <p
              style={{
                marginTop: space.md,
                fontSize: fontSize.md,
                lineHeight: 1.8,
                color: brandOnDark.textSub,
              }}
            >
              Agent 协作平台让 AI 智能体以真实团队的组织方式协同工作：提交一个任务，平台
              自动按需组建产品、架构、开发、测试四位虚拟成员；任务状态实时流转，群聊中通过
              @ 定向指派，每个 Agent 只响应被指派的工作，产出物沉淀为可追溯的项目文档。
            </p>
          </div>

          <div>
            <div
              style={{
                fontSize: fontSize.md,
                fontWeight: 600,
                color: brandOnDark.textStrong,
              }}
            >
              核心特性
            </div>
            <ul
              style={{
                marginTop: space.md,
                display: "flex",
                flexDirection: "column",
                gap: space.sm,
                listStyle: "none",
                padding: 0,
                fontSize: fontSize.md,
                color: brandOnDark.textList,
              }}
            >
              {[
                "任务提交一键组队：需求即入口，团队自动组建",
                "仅被 @ 的 Agent 响应：消息精准定向，避免噪音",
                "产出物沉淀为项目文档：交付全程可追溯",
                "任务看板实时流转：状态变更全局广播，协作透明",
                "群聊 + 私聊双通道：团队协作与一对一沟通并重",
              ].map((t) => (
                <li
                  key={t}
                  style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}
                >
                  <span
                    aria-hidden
                    style={{ color: brandOnDark.accent, fontWeight: 700, lineHeight: 1.7 }}
                  >
                    ✓
                  </span>
                  <span style={{ lineHeight: 1.7 }}>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 桌面端底部四角色点缀（沉底） */}
      {!compact && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            fontSize: fontSize.xs,
            color: brandOnDark.textMuted,
            marginTop: "auto",
          }}
        >
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

/** 认证页白色表单卡片容器样式（登录/注册共用，浅色背景下细腻阴影浮现） */
export const authCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 400,
  padding: `${space.xxl}px ${space.xl}px`,
  borderRadius: radius.lg,
  backgroundColor: "var(--color-surface)",
  boxShadow:
    "0 8px 40px rgba(15,23,42,.08), 0 2px 8px rgba(15,23,42,.05)",
  display: "flex",
  justifyContent: "center",
};

/** 认证表单输入框基础样式（登录/注册共用） */
export const authInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.md}px ${space.lg}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  fontSize: fontSize.md,
  color: neutral[800],
  outline: "none",
  fontFamily: fontFamily.body,
};

/** 认证主按钮样式（登录/注册共用：品牌蓝 + 投影） */
export const authSubmitStyle: CSSProperties = {
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
};

/** 认证字段标签样式（登录/注册共用） */
export const authLabelStyle: CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 500,
  color: neutral[600],
};
