"use client";

/**
 * 注册页（ISSUE-011：登录页「立即注册」死链修复）
 * =====================================================
 * 对齐登录页（login/page.tsx）布局与视觉语言：共享 BrandPanel 品牌区 +
 * 白色表单卡片。字段对齐后端 RegisterDto：username / displayName 必填、
 * password 必填且 >= 6 位、email 可选。
 * - 提交 → POST /auth/register（后端 register 仅返回 {id, username,
 *   displayName}，不含 token → 成功跳 /login?registered=1，登录页提示可登录）。
 * - 校验：username / displayName 必填、password 长度 >= 6、email 格式。
 * - 已登录用户直接进入工作区（对齐登录页）。
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
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

/** 简单邮箱格式校验（对齐后端 RegisterDto @IsEmail，前端即时反馈） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RegisterForm() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
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

    const name = username.trim();
    const shown = displayName.trim();
    const mail = email.trim();

    if (!name) {
      setError("请输入账号");
      return;
    }
    if (!shown) {
      setError("请输入展示名");
      return;
    }
    if (!password) {
      setError("请输入密码");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (mail && !EMAIL_RE.test(mail)) {
      setError("邮箱格式不正确");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.post("/auth/register", {
        username: name,
        displayName: shown,
        password,
        email: mail || undefined,
      });
      router.push("/login?registered=1");
    } catch (err) {
      setError(isApiError(err) ? err.message : "注册失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
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
          创建账号
        </div>
        <div style={{ fontSize: fontSize.md, color: neutral[400], marginTop: space.xs }}>
          注册后即可进入你的 AI 协作工作区
        </div>
      </div>

      {/* 账号 / 展示名 / 密码 / 邮箱（可选） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label htmlFor="register-username" style={authLabelStyle}>
            账号
          </label>
          <input
            id="register-username"
            data-testid="register-username"
            type="text"
            placeholder="请输入账号（登录用，唯一）"
            autoComplete="username"
            aria-label="账号"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            style={authInputStyle}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label htmlFor="register-displayname" style={authLabelStyle}>
            展示名
          </label>
          <input
            id="register-displayname"
            data-testid="register-displayname"
            type="text"
            placeholder="请输入展示名"
            autoComplete="name"
            aria-label="展示名"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            style={authInputStyle}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label htmlFor="register-password" style={authLabelStyle}>
            密码
          </label>
          <input
            id="register-password"
            data-testid="register-password"
            type="password"
            placeholder="请输入密码（至少 6 位）"
            autoComplete="new-password"
            aria-label="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            style={authInputStyle}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label htmlFor="register-email" style={authLabelStyle}>
            邮箱（可选）
          </label>
          <input
            id="register-email"
            data-testid="register-email"
            type="email"
            placeholder="请输入邮箱（选填）"
            autoComplete="email"
            aria-label="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            style={authInputStyle}
          />
        </div>
      </div>

      {/* 错误提示（与登录页视觉语言一致：小字号 + 语义红） */}
      {error && (
        <div
          data-testid="register-error"
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

      {/* 注册按钮 */}
      <button
        type="submit"
        data-testid="register-submit"
        disabled={submitting}
        style={{
          ...authSubmitStyle,
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? "注册中…" : "注册"}
      </button>

      {/* 登录入口 */}
      <div style={{ textAlign: "center", fontSize: fontSize.md, color: neutral[400] }}>
        已有账号？
        <Link
          href="/login"
          data-testid="register-login-link"
          style={{ color: "#2563EB", fontWeight: 500, marginLeft: space.xs, textDecoration: "none" }}
        >
          去登录
        </Link>
      </div>
    </form>
  );
}

export default function RegisterPage() {
  const isMobile = useIsMobile();
  return (
    /* 全屏浅色渐变背景（对齐登录页）；表单白色卡片悬浮聚焦 */
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
          {/* 白色表单卡片：浅色背景下以细腻阴影浮现，聚焦注册操作 */}
          <div style={authCardStyle}>
            <RegisterForm />
          </div>
        </main>
        {/* 桌面端：左侧品牌区 */}
        {!isMobile && <BrandPanel compact={false} />}
      </div>
    </div>
  );
}
