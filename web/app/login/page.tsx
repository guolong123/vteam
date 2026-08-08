"use client";

/**
 * 登录页（Task 11：原型保真迁移 + 真实认证）
 * =====================================================
 * 平台级登录入口：左品牌区（Logo 占位 + 产品名 + 价值主张）+ 右登录表单。
 * - 保真迁移自 docs/agent-platform/prototypes/login/index.tsx（布局/样式/data-testid/文案零改动）。
 * - 接入真实认证：表单提交 → POST /api/v1/auth/login → token 存 authStore → 跳 /projects。
 * - 错误凭证：显示错误提示（与原型视觉语言一致），不跳转。
 * - 桌面分栏布局；移动端品牌区折叠为顶栏、表单单列。
 * - 全站浅色主题：品牌区用极浅渐变（白 → 极淡蓝 → 极淡紫，呼应 Logo 但压到极浅），登录表单区保持浅色 radial。
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore, type User } from "@/lib/stores/authStore";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

/** POST /auth/login 响应（Task 15：accessToken + refreshToken + user） */
interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/** 品牌区浅色渐变：白 → 极浅蓝紫（呼应 Logo 色系，与全站浅色主题协调） */
const brandBg =
  "linear-gradient(160deg, #FFFFFF 0%, #F8FAFC 55%, #EEF2FF 100%)";

/** 品牌区浅色底上的深色文字/边框/点缀（对齐 neutral 系层级） */
const brandOnDark = {
  glow: "radial-gradient(70% 55% at 15% 85%, rgba(59,130,246,.1), transparent 70%)",
  text: "#0F172A",
  textStrong: "#1E293B",
  textSub: "rgba(15,23,42,.6)",
  textMuted: "rgba(15,23,42,.5)",
  textList: "rgba(15,23,42,.7)",
  border: "#E2E8F0",
  accent: "#3B82F6",
} as const;

/** 移动端检测：< breakpoint 视为 mobile（品牌区折叠为顶栏） */
function useIsMobile(breakpoint = 768) {
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

function BrandPanel({ compact }: { compact: boolean }) {
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
            <div style={{ fontSize: fontSize.xs, color: brandOnDark.textSub, marginTop: space.xs }}>
              让 AI 智能体像真实团队一样协同工作
            </div>
          )}
        </div>
      </div>

      {/* 桌面端价值主张区 */}
      {!compact && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xl * 2 }}>
          <div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, lineHeight: 1.5, color: brandOnDark.textStrong }}>
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
            <div style={{ fontSize: fontSize.md, fontWeight: 600, color: brandOnDark.textStrong }}>
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
                <li key={t} style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
                  <span aria-hidden style={{ color: brandOnDark.accent, fontWeight: 700, lineHeight: 1.7 }}>
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

function LoginForm() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登录用户直接进入工作区
  useEffect(() => {
    const token = useAuthStore.getState().token;
    if (token) {
      router.replace("/projects");
    }
  }, [router]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    if (!username.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<LoginResponse>("/auth/login", {
        username: username.trim(),
        password,
      });
      setAuth(res.accessToken, res.user);
      router.push("/projects");
    } catch (err) {
      setError(isApiError(err) ? err.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

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
    <form
      onSubmit={handleSubmit}
      noValidate
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
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            style={inputBase}
          />
        </div>
      </div>

      {/* 错误提示（与原型视觉语言一致：小字号 + 语义红） */}
      {error && (
        <div
          data-testid="login-error"
          role="alert"
          style={{
            fontSize: fontSize.sm,
            color: "#DC2626",
            display: "flex",
            alignItems: "center",
            gap: space.xs,
          }}
        >
          <span aria-hidden style={{ fontWeight: 700 }}>!</span>
          {error}
        </div>
      )}

      {/* 登录按钮 */}
      <button
        type="submit"
        data-testid="login-button"
        disabled={submitting}
        style={{
          width: "100%",
          padding: `${space.md + 2}px ${space.lg}px`,
          borderRadius: radius.md,
          border: "none",
          backgroundColor: "#2563EB",
          color: "#FFFFFF",
          fontSize: fontSize.lg,
          fontWeight: 600,
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.7 : 1,
          boxShadow: "0 6px 16px rgba(37,99,235,.3)",
          fontFamily: fontFamily.body,
        }}
      >
        {submitting ? "登录中…" : "登录"}
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
    </form>
  );
}

export default function LoginPage() {
  const isMobile = useIsMobile();
  return (
    /* 全屏浅色渐变背景（白 → 浅灰 → 极浅蓝，与全站浅色主题协调）；表单白色卡片悬浮聚焦 */
    <div
      style={{
        minHeight: "100vh",
        background:
          "linear-gradient(160deg, #FFFFFF 0%, #F8FAFC 50%, #EEF2FF 100%)",
        fontFamily: fontFamily.body,
      }}
    >
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          width: "100%",
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
          }}
        >
          {/* 白色表单卡片：浅色背景下以细腻阴影浮现，聚焦登录操作 */}
          <div
            style={{
              width: "100%",
              maxWidth: 400,
              padding: `${space.xxl}px ${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              boxShadow: "0 8px 40px rgba(15,23,42,.08), 0 2px 8px rgba(15,23,42,.05)",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <LoginForm />
          </div>
        </main>
        {/* 桌面端：左侧品牌区 */}
        {!isMobile && <BrandPanel compact={false} />}
      </div>
    </div>
  );
}