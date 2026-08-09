"use client";

/**
 * 新增 Worker 安装向导页（Phase 5 F1 2A：worker-install 原型迁移）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/worker-install/index.tsx（07 篇 11.2 / 11.4）。
 * 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 *
 * - 3 步安装向导：① 基础配置（serverUrl / workerId / 能力声明）→ ② 安装方式（curl / docker 双 Tab）
 *   → ③ 安装命令（mono 深色底 + 复制）+ 步骤说明；底部完成 / 取消 + 入池提示。
 * - 受控输入动态拼接命令（对齐原型：curl 一键脚本 / docker 环境变量注入）。
 * - curl 下载地址动态化：脚本由控制面 web 静态服务提供（/install-worker.sh），下载 URL 与
 *   serverUrl 默认值均取当前页面访问地址（window.location.origin，挂载后填充避免 SSR mismatch）——
 *   不再硬编码 example 地址。
 * - 纯静态展示（不执行真实安装）；复制按钮为唯一增强交互：navigator.clipboard 写剪贴板
 *   （原型"复制"占位语义），失败静默降级。
 * - data-testid 与原型一致（17 个）：worker-install-root/install-wizard/install-config/
 *   server-url-input/worker-id-input/regenerate-worker-id-button/capability-config/
 *   install-method-section/install-method-tabs/install-method-tab/install-command-section/
 *   install-command/copy-command-button/install-steps/install-footer/
 *   install-confirm-button/install-cancel-button。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  neutral,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 安装方式 */
type InstallMethod = "curl" | "docker";

/** 表单字段行：标签 + 说明 + 输入槽（原型 FieldRow） */
function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{label}</span>
        {hint && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** 输入框统一样式（原型 inputStyle） */
const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "#FFFFFF",
  color: neutral[800],
  fontSize: fontSize.md,
  fontFamily: fontFamily.mono,
  outline: "none",
};

/** 步骤编号圆点（① ② ③，原型同款蓝阶） */
function StepBadge({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: 24,
        height: 24,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#EFF6FF",
        color: "#2563EB",
        fontSize: fontSize.md,
        fontWeight: 700,
      }}
    >
      {index}
    </span>
  );
}

/** 命令展示区：浅色 mono 底 + 复制按钮（install-command / copy-command-button） */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用（非安全上下文等）→ 静默降级为原型静态语义 */
    }
  };

  return (
    <div
      data-testid="install-command"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.md,
      }}
    >
      <span aria-hidden style={{ color: roleText.developer, fontSize: fontSize.lg, lineHeight: 1, flexShrink: 0 }}>
        $
      </span>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          color: neutral[800],
          fontSize: fontSize.md,
          fontFamily: fontFamily.mono,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {command}
      </code>
      <button
        type="button"
        data-testid="copy-command-button"
        data-method="current"
        aria-label="复制安装命令"
        onClick={handleCopy}
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: copied ? "#ECFDF5" : neutral[50],
          color: copied ? "#059669" : neutral[600],
          fontSize: fontSize.sm,
          cursor: "pointer",
          fontFamily: fontFamily.body,
        }}
      >
        <span aria-hidden>⧉</span>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/** 安装步骤说明条（3 步，install-steps） */
function InstallSteps({ steps }: { steps: string[] }) {
  return (
    <div data-testid="install-steps" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      {steps.map((step, idx) => (
        <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: space.md }}>
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#EFF6FF",
              border: "1px solid #BFDBFE",
              color: "#2563EB",
              fontSize: fontSize.sm,
              fontWeight: 600,
              marginTop: 1,
            }}
          >
            {idx + 1}
          </span>
          <span style={{ fontSize: fontSize.md, color: neutral[600], lineHeight: 1.6 }}>{step}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ 页面主组件（AppShell 内容区） ------------------------------ */

export default function WorkerInstallPage() {
  const router = useRouter();

  /* 安装方式 Tab（受控） */
  const [method, setMethod] = useState<InstallMethod>("curl");

  /* 当前页面访问地址（origin）：挂载后填充（SSR 首帧不可读 window，避免 hydration mismatch），
     curl 下载 URL 与 serverUrl 默认值的数据源 */
  const [pageOrigin, setPageOrigin] = useState("");
  useEffect(() => {
    setPageOrigin(window.location.origin);
  }, []);

  /* 参数配置（受控，动态拼接到命令展示） */
  const [serverUrl, setServerUrl] = useState("");
  const [workerId, setWorkerId] = useState("worker-05");
  const [concurrency, setConcurrency] = useState(8);
  const [opencodeVersion, setOpencodeVersion] = useState("v2.0.0-beta.1");

  /* serverUrl 初始值跟随页面 origin（用户可手动修改） */
  useEffect(() => {
    setServerUrl((cur) => (cur ? cur : pageOrigin));
  }, [pageOrigin]);

  /* 两种安装方式的命令；curl 下载地址 = 当前 origin + /install-worker.sh */
  const curlCommand = `curl -fsSL ${pageOrigin}/install-worker.sh | bash -s -- --server ${serverUrl} --worker-id ${workerId} --concurrency ${concurrency} --opencode ${opencodeVersion}`;
  const dockerCommand = `docker run -d --name opencode-worker-${workerId} -e SERVER_URL=${serverUrl} -e WORKER_ID=${workerId} -e CONCURRENCY=${concurrency} -e OPENCODE_VERSION=${opencodeVersion} -p 18080:18080 ketaops/opencode-worker:latest`;

  const command = method === "curl" ? curlCommand : dockerCommand;

  const curlSteps = [
    "在目标机器（任意网络位置，无需控制面反向可达）执行右侧 curl 命令",
    "脚本自动拉取 worker 源码、安装依赖并写入配置（SERVER_URL / WORKER_ID / X_WORKER_TOKEN），启动后向控制面注册",
    "等待首次心跳（worker→控制面 SSE 通道），注册表出现后即自动入池调度",
  ];

  const dockerSteps = [
    "在目标机器执行 docker run 命令，拉取 ketaops/opencode-worker 镜像",
    "容器启动后读取环境变量注入的 SERVER_URL / WORKER_ID / 能力声明并注册",
    "等待首次心跳，容器端口 18080 为 WorkerServer HTTP 端点（协议层 v1/v2 不变）",
  ];

  const steps = method === "curl" ? curlSteps : dockerSteps;

  /* Tab 配置 */
  const methods: { key: InstallMethod; label: string; icon: string; desc: string }[] = [
    { key: "curl", label: "curl 命令安装", icon: "⌥", desc: "一键脚本 · 适合裸机 / 已有环境" },
    { key: "docker", label: "docker 容器安装", icon: "▣", desc: "容器化 · 隔离与版本可回滚" },
  ];

  /** 重新生成 workerId（原型占位按钮 → 真实随机，仍满足"自动生成可修改"语义） */
  const regenerateWorkerId = () => {
    const rand = Math.floor(10 + Math.random() * 90);
    setWorkerId(`worker-${String(rand).padStart(2, "0")}`);
  };

  return (
    <div
      data-testid="worker-install-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`,
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 内容区：居中向导卡片 */}
      <main style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.xl,
          }}
        >
          {/* 向导卡片 */}
          <div
            data-testid="install-wizard"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.xl,
              padding: `${space.xxl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.md,
              ...baseFont,
            }}
          >
            {/* ① 基础配置 */}
            <section data-testid="install-config" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <StepBadge index={1} />
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  基础配置
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>对齐 11.2 Worker 注册配置</span>
              </div>

              <FieldRow label="控制面地址（serverUrl）" hint="worker 主动 outbound 连接，可跨网络边界">
                <input
                  data-testid="server-url-input"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  spellCheck={false}
                  style={inputStyle}
                />
              </FieldRow>

              <FieldRow label="Worker 标识（workerId）" hint="全局唯一 · 自动生成可修改">
                <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <input
                    data-testid="worker-id-input"
                    value={workerId}
                    onChange={(e) => setWorkerId(e.target.value)}
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    data-testid="regenerate-worker-id-button"
                    title="重新生成 workerId"
                    onClick={regenerateWorkerId}
                    style={{
                      flexShrink: 0,
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: neutral[50],
                      color: neutral[600],
                      fontSize: fontSize.md,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    ↻ 重新生成
                  </button>
                </div>
              </FieldRow>

              {/* 能力声明：并发上限 + opencode 版本 */}
              <div data-testid="capability-config" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                <FieldRow label="并发上限" hint="能力声明 · 调度依据">
                  <select
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                    style={{ ...inputStyle, cursor: "pointer" }}
                  >
                    {[2, 4, 6, 8, 12, 16].map((n) => (
                      <option key={n} value={n}>
                        {n} 并发
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <FieldRow label="opencode 版本" hint="v2 迁移只动 Worker 侧（11.5）">
                  <select
                    value={opencodeVersion}
                    onChange={(e) => setOpencodeVersion(e.target.value)}
                    style={{ ...inputStyle, cursor: "pointer" }}
                  >
                    <option value="v2.0.0-beta.1">v2.0.0-beta.1（V2Runtime）</option>
                    <option value="v1.18.14">v1.18.14（V1Runtime）</option>
                  </select>
                </FieldRow>
              </div>
            </section>

            {/* ② 安装方式选择 */}
            <section data-testid="install-method-section" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <StepBadge index={2} />
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  选择安装方式
                </span>
              </div>

              {/* Tab 切换 */}
              <div
                data-testid="install-method-tabs"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: space.sm,
                  padding: space.xs,
                  borderRadius: radius.lg,
                  backgroundColor: neutral[100],
                }}
              >
                {methods.map((m) => {
                  const active = method === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      data-testid="install-method-tab"
                      data-method={m.key}
                      data-active={active ? "true" : "false"}
                      onClick={() => setMethod(m.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.md}px ${space.lg}px`,
                        borderRadius: radius.md,
                        border: "none",
                        backgroundColor: active ? "#FFFFFF" : "transparent",
                        boxShadow: active ? shadow.sm : "none",
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: fontFamily.body,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 30,
                          height: 30,
                          flexShrink: 0,
                          borderRadius: radius.md,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: active ? "#EFF6FF" : neutral[100],
                          color: active ? "#2563EB" : neutral[400],
                          fontSize: fontSize.lg,
                        }}
                      >
                        {m.icon}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: fontSize.md, fontWeight: 600, color: active ? neutral[900] : neutral[600] }}>
                          {m.label}
                        </span>
                        <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                          {m.desc}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ③ 安装命令 */}
            <section data-testid="install-command-section" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <StepBadge index={3} />
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  {method === "curl" ? "curl 命令安装" : "docker 容器安装"}
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>
                  在目标机器执行
                </span>
              </div>

              <CommandBlock command={command} />

              {/* 安装步骤说明 */}
              <InstallSteps steps={steps} />
            </section>
          </div>

          {/* 底部操作：完成 / 取消 + 安装指引提示 */}
          <div
            data-testid="install-footer"
            style={{ display: "flex", alignItems: "center", gap: space.md }}
          >
            <button
              type="button"
              data-testid="install-confirm-button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.sm + 2}px ${space.xl}px`,
                borderRadius: radius.pill,
                border: "none",
                backgroundColor: "#2563EB",
                color: "#FFFFFF",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                fontFamily: fontFamily.body,
              }}
            >
              完成安装
            </button>
            <button
              type="button"
              data-testid="install-cancel-button"
              onClick={() => router.push("/workers")}
              style={{
                padding: `${space.sm + 2}px ${space.xl}px`,
                borderRadius: radius.pill,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
                color: neutral[600],
                fontSize: fontSize.md,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              取消
            </button>
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: space.xs,
                fontSize: fontSize.xs,
                color: neutral[400],
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.sm }}>▣</span>
              注册即入池 · 无需重启控制面（11.4 水平扩容）
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
