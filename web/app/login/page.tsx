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
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore, type User } from "@/lib/stores/authStore";
import { neutral, space, fontSize, fontFamily } from "@/src/theme/tokens";
import {
  BrandPanel,
  useIsMobile,
  pageBg,
  authCardStyle,
  authInputStyle,
  authSubmitStyle,
  authLabelStyle,
} from "@/src/components/auth/BrandPanel";

/** POST /auth/login 响应（Task 15：accessToken + refreshToken + user） */
interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/** 登录页视图模式：登录 / 忘记密码（申请 token）/ 重置密码（token 换新密码） */
type AuthMode = "login" | "forgot" | "reset";

function LoginForm() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  // 视图模式：login / forgot（忘记密码申请 token）/ reset（token 换新密码）
  const [mode, setMode] = useState<AuthMode>("login");

  // 登录表单
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 密码重置成功回跳提示（UX-12）
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  // 注册成功回跳协议：?registered=1 → 提示可登录（useEffect 读 URL，SSR 安全）
  const [showRegistered, setShowRegistered] = useState(false);

  // 忘记密码表单
  const [account, setAccount] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  // 重置密码表单
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // 已登录用户直接进入工作区
  useEffect(() => {
    const token = useAuthStore.getState().token;
    if (token) {
      router.replace("/projects");
    }
  }, [router]);

  // 注册成功回跳提示（客户端读取并清理 query，SSR 安全）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("registered") === "1") {
      setShowRegistered(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("registered");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

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
      // 记住我：勾选 → localStorage 跨会话；未勾选 → sessionStorage 会话级
      useAuthStore.getState().setPersistMode(rememberMe);
      setAuth(res.accessToken, res.user);
      router.push("/projects");
    } catch (err) {
      setError(isApiError(err) ? err.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (forgotSubmitting) return;

    if (!account.trim()) {
      setForgotError("请输入用户名或邮箱");
      return;
    }

    setForgotSubmitting(true);
    setForgotError(null);
    try {
      const res = await api.post<{ resetToken: string }>(
        "/auth/forgot-password",
        { account: account.trim() },
      );
      // 内网无邮件：接口直接返回一次性 token，预填进重置表单
      setResetToken(res.resetToken);
      setMode("reset");
    } catch (err) {
      setForgotError(isApiError(err) ? err.message : "获取重置 token 失败，请稍后重试");
    } finally {
      setForgotSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (resetSubmitting) return;

    if (!resetToken.trim()) {
      setResetError("请输入重置 token");
      return;
    }
    if (!newPassword) {
      setResetError("请输入新密码");
      return;
    }
    if (newPassword.length < 6) {
      setResetError("新密码至少 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError("两次输入的密码不一致");
      return;
    }

    setResetSubmitting(true);
    setResetError(null);
    try {
      await api.post("/auth/reset-password", {
        token: resetToken.trim(),
        newPassword,
      });
      // 成功后回登录页并提示使用新密码
      setMode("login");
      setResetToken("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
      setResetNotice("密码重置成功，请使用新密码登录");
    } catch (err) {
      setResetError(isApiError(err) ? err.message : "重置密码失败，请稍后重试");
    } finally {
      setResetSubmitting(false);
    }
  };

  const backToLogin = () => {
    setMode("login");
    setForgotError(null);
    setResetError(null);
  };

  const titleMap: Record<AuthMode, string> = {
    login: "欢迎回来",
    forgot: "忘记密码",
    reset: "重置密码",
  };
  const subtitleMap: Record<AuthMode, string> = {
    login: "登录以进入你的 AI 协作工作区",
    forgot: "输入用户名或邮箱，获取一次性重置 token",
    reset: "输入重置 token 与新密码，重设账号密码",
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
          {titleMap[mode]}
        </div>
        <div style={{ fontSize: fontSize.md, color: neutral[400], marginTop: space.xs }}>
          {subtitleMap[mode]}
        </div>
      </div>

      {mode === "login" && (
        <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
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
                style={authInputStyle}
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
                style={authInputStyle}
              />
            </div>
          </div>

          {/* 记住我 / 忘记密码（UX-12） */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: -space.sm,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.xs,
                fontSize: fontSize.sm,
                color: neutral[600],
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                data-testid="remember-me"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={submitting}
                style={{ width: 14, height: 14, accentColor: "#2563EB", cursor: "pointer" }}
              />
              记住我
            </label>
            <button
              type="button"
              data-testid="forgot-password-link"
              onClick={() => {
                setMode("forgot");
                setForgotError(null);
              }}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: fontSize.sm,
                color: "#2563EB",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              忘记密码？
            </button>
          </div>

          {/* 重置成功提示（UX-12，从忘记密码闭环回跳） */}
          {resetNotice && (
            <div
              data-testid="reset-success"
              role="status"
              style={{
                fontSize: fontSize.sm,
                color: "#059669",
                display: "flex",
                alignItems: "center",
                gap: space.xs,
              }}
            >
              <span aria-hidden style={{ fontWeight: 700 }}>✓</span>
              {resetNotice}
            </div>
          )}

          {/* 注册成功提示（注册页回跳 ?registered=1） */}
          {showRegistered && (
            <div
              data-testid="register-success"
              role="status"
              style={{
                fontSize: fontSize.sm,
                color: "#059669",
                display: "flex",
                alignItems: "center",
                gap: space.xs,
              }}
            >
              <span aria-hidden style={{ fontWeight: 700 }}>✓</span>
              注册成功，请使用新账号登录
            </div>
          )}

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
              ...authSubmitStyle,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "登录中…" : "登录"}
          </button>

          {/* 注册入口（ISSUE-011：纯 span 死链 → Link /register） */}
          <div style={{ textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
            还没有账号？
            <Link
              href="/register"
              data-testid="register-link"
              style={{ color: "#2563EB", fontWeight: 500, marginLeft: space.xs, textDecoration: "none" }}
            >
              立即注册
            </Link>
          </div>
        </form>
      )}

      {mode === "forgot" && (
        <form onSubmit={handleForgotSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            <label htmlFor="forgot-account" style={authLabelStyle}>
              用户名或邮箱
            </label>
            <input
              id="forgot-account"
              data-testid="forgot-account"
              type="text"
              placeholder="请输入注册时的用户名或邮箱"
              autoComplete="username"
              aria-label="用户名或邮箱"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              disabled={forgotSubmitting}
              style={authInputStyle}
            />
          </div>

          {forgotError && (
            <div
              data-testid="forgot-error"
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
              {forgotError}
            </div>
          )}

          <button
            type="submit"
            data-testid="forgot-submit"
            disabled={forgotSubmitting}
            style={{
              ...authSubmitStyle,
              cursor: forgotSubmitting ? "default" : "pointer",
              opacity: forgotSubmitting ? 0.7 : 1,
            }}
          >
            {forgotSubmitting ? "获取中…" : "获取重置 token"}
          </button>

          <div style={{ textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
            <button
              type="button"
              data-testid="back-to-login"
              onClick={backToLogin}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: fontSize.md,
                color: "#2563EB",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              返回登录
            </button>
          </div>
        </form>
      )}

      {mode === "reset" && (
        <form onSubmit={handleResetSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <label htmlFor="reset-token" style={authLabelStyle}>
                重置 token
              </label>
              <input
                id="reset-token"
                data-testid="reset-token-input"
                type="text"
                placeholder="粘贴获取到的一次性重置 token"
                aria-label="重置 token"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                disabled={resetSubmitting}
                style={{ ...authInputStyle, fontFamily: fontFamily.mono }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <label htmlFor="reset-new-password" style={authLabelStyle}>
                新密码
              </label>
              <input
                id="reset-new-password"
                data-testid="reset-new-password"
                type="password"
                placeholder="请输入新密码（至少 6 位）"
                autoComplete="new-password"
                aria-label="新密码"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={resetSubmitting}
                style={authInputStyle}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              <label htmlFor="reset-confirm-password" style={authLabelStyle}>
                确认新密码
              </label>
              <input
                id="reset-confirm-password"
                data-testid="reset-confirm-password"
                type="password"
                placeholder="请再次输入新密码"
                autoComplete="new-password"
                aria-label="确认新密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={resetSubmitting}
                style={authInputStyle}
              />
            </div>
          </div>

          {resetError && (
            <div
              data-testid="reset-error"
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
              {resetError}
            </div>
          )}

          <button
            type="submit"
            data-testid="reset-submit"
            disabled={resetSubmitting}
            style={{
              ...authSubmitStyle,
              cursor: resetSubmitting ? "default" : "pointer",
              opacity: resetSubmitting ? 0.7 : 1,
            }}
          >
            {resetSubmitting ? "重置中…" : "重置密码"}
          </button>

          <div style={{ textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
            <button
              type="button"
              data-testid="back-to-login"
              onClick={backToLogin}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: fontSize.md,
                color: "#2563EB",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              返回登录
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  const isMobile = useIsMobile();
  return (
    /* 全屏浅色渐变背景（白 → 浅灰 → 极浅蓝，与全站浅色主题协调）；表单白色卡片悬浮聚焦 */
    <div
      style={{
        minHeight: "100vh",
        background: pageBg,
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
          <div style={authCardStyle}>
            <LoginForm />
          </div>
        </main>
        {/* 桌面端：左侧品牌区 */}
        {!isMobile && <BrandPanel compact={false} />}
      </div>
    </div>
  );
}