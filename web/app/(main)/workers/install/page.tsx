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
 * - 真实默认值（MOCK-03）：opencode 版本默认 v1.18.15（= worker/package.json @opencode-ai/sdk
 *   实际版本，非原型假版本 v2.0.0-beta.1——worker 侧暂无 V2Runtime 实现，v2 仅调研计划，见 07 篇）；
 *   workerId 初始随机生成（worker-XX，与「重新生成」按钮同源逻辑，替代示例值 worker-05）。
 * - 纯静态展示（不执行真实安装）；复制按钮为唯一增强交互：navigator.clipboard 写剪贴板
 *   （原型"复制"占位语义），失败静默降级。
 * - data-testid 与原型一致（20 个）：worker-install-root/install-wizard/install-config/
 *   server-url-input/worker-id-input/regenerate-worker-id-button/capability-config/
 *   advertise-host-input/serve-hostname-input/mcp-url-input/
 *   install-method-section/install-method-tabs/install-method-tab/install-command-section/
 *   install-command/copy-command-button/install-steps/install-footer/
 *   install-confirm-button/install-cancel-button。
 *
 * - 网络可达性（可选）：外部/跨机 worker 专用参数（--advertise-host / --serve-hostname / --mcp-url），
 *   --advertise-host 只需填 IP（http:// 与端口由脚本/worker 自动处理；不填则 worker 自动探测本机 IP）；
 *   空值不拼接，集群内/本机 worker 无需配置；详见 worker install-worker.sh。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
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

/** 生成随机 workerId（worker-XX，10-99；安装向导初始值 + 「重新生成」按钮共用） */
function randomWorkerId(): string {
  const rand = Math.floor(10 + Math.random() * 90);
  return `worker-${String(rand).padStart(2, "0")}`;
}

/**
 * 清洗用户输入的 IP 地址（trim → 去协议 → 去路径 → 去端口）。
 * 支持脏值输入（用户手滑填了完整 URL），输出纯净 IP。
 *
 * IPv6 例外：`[::1]` 或 `[2001:db8::1]` 保留方括号（CLI 期望 `[addr]`）。
 *
 * @example
 * sanitizeIp("  http://192.168.1.100:8080/path  ") // "192.168.1.100"
 * sanitizeIp("https://[::1]:9090")                  // "[::1]"
 * sanitizeIp("10.0.0.1")                           // "10.0.0.1"
 * sanitizeIp("")                                    // ""
 */
function sanitizeIp(raw: string): string {
  let ip = raw.trim();
  if (!ip) return "";

  // 去掉协议前缀（http:// 或 https://）
  ip = ip.replace(/^https?:\/\//i, "");

  // 去掉路径（第一个 / 后截断）
  const slashIdx = ip.indexOf("/");
  if (slashIdx !== -1) ip = ip.slice(0, slashIdx);

  // IPv6 用方括号包裹 → 保留 [addr]，去掉端口
  const bracketOpen = ip.indexOf("[");
  const bracketClose = ip.indexOf("]");
  if (bracketOpen !== -1 && bracketClose !== -1) {
    // 取 [addr] 内容，丢弃 ] 后的 :port
    ip = ip.slice(bracketOpen, bracketClose + 1);
  } else {
    // IPv4 或裸 IPv6：去掉端口（最后一个 : 后是端口）
    const lastColon = ip.lastIndexOf(":");
    if (lastColon !== -1) {
      // 确认 : 后面全是数字（端口），而非 IPv6 内部的冒号
      const afterColon = ip.slice(lastColon + 1);
      if (/^\d+$/.test(afterColon)) {
        ip = ip.slice(0, lastColon);
      }
    }
  }

  return ip;
}

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
  backgroundColor: "var(--color-surface)",
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
        backgroundColor: "rgba(37,99,235,0.10)",
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
          backgroundColor: copied ? "rgba(16,185,129,0.10)" : neutral[50],
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
              backgroundColor: "rgba(37,99,235,0.10)",
              border: "1px solid rgba(37,99,235,0.22)",
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
  const user = useAuthStore((s) => s.user);

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
  const [workerId, setWorkerId] = useState("");
  const [workerToken, setWorkerToken] = useState("");
  const [concurrency, setConcurrency] = useState(8);
  /* 默认值 = worker 实际运行的稳定版本（worker/package.json @opencode-ai/sdk 1.18.15），
     非原型假版本 v2.0.0-beta.1（worker 侧暂无 V2Runtime 实现，v2 仅调研计划，见 07 篇） */
  const [opencodeVersion, setOpencodeVersion] = useState("v1.18.15");

  /* 网络可达性（可选）：外部/跨机 worker 专用，空值不拼接命令——集群内/本机无需配置 */
  const [advertiseHost, setAdvertiseHost] = useState("");
  const [serveHostname, setServeHostname] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [workDir, setWorkDir] = useState("");

  /* serverUrl 初始值跟随页面 origin（用户可手动修改） */
  useEffect(() => {
    setServerUrl((cur) => (cur ? cur : pageOrigin));
  }, [pageOrigin]);

  /* MCP 地址默认值 = 当前控制面地址 + /api/v1/platform-mcp（内置 MCP 入口；外部/集群外场景可手动改） */
  useEffect(() => {
    if (pageOrigin) {
      setMcpUrl((cur) => cur || `${pageOrigin}/api/v1/platform-mcp`);
    }
  }, [pageOrigin]);

  /* workerId 初始随机生成：SSR 首帧空串 → 挂载后填充（对齐 pageOrigin 模式避免 hydration mismatch，
     替代原型示例值 worker-05，避免固定 id 多 worker 冲突） */
  useEffect(() => {
    setWorkerId(randomWorkerId());
  }, []);

  /* 注册 token 自动拉取（GET /workers/register-token，workers.view）：
     保证复制命令即带 --token，无需手工填写；拉取失败（权限不足/网络）保留空值走手动引导 */
  useEffect(() => {
    if (!user?.id) return;
    api
      .get<{ token: string }>("/workers/register-token")
      .then((r) => {
        if (r.token) setWorkerToken(r.token);
      })
      .catch(() => {
        /* 静默：无权限或异常时由脚本端引导手动填写 */
      });
  }, [user?.id]);

  /* 两种安装方式的命令；curl 下载地址 = 当前 origin + /install-worker.sh。
     token 非空时追加 --token，保证复制命令即可完整安装（脚本自动写入 X_WORKER_TOKEN）；
     --advertise-host 传入经 sanitizeIp 清洗的纯 IP，脚本自动补 http:// 前缀 */
  const curlCommand = `curl -fsSL ${pageOrigin}/install-worker.sh | bash -s -- --server ${serverUrl} --worker-id ${workerId} --concurrency ${concurrency} --opencode ${opencodeVersion}${workerToken ? ` --token ${workerToken}` : ""}${advertiseHost ? ` --advertise-host http://${sanitizeIp(advertiseHost)}` : ""}${serveHostname ? ` --serve-hostname ${serveHostname}` : ""}${mcpUrl ? ` --mcp-url ${mcpUrl}` : ""}${workDir ? ` --work-dir ${workDir}` : ""}`;
  const dockerCommand = `docker run -d --name opencode-worker-${workerId} -e SERVER_URL=${serverUrl} -e WORKER_ID=${workerId} -e CONCURRENCY=${concurrency} -e OPENCODE_VERSION=${opencodeVersion} -p 18080:18080 ketaops/opencode-worker:latest`;

  const command = method === "curl" ? curlCommand : dockerCommand;

  const curlSteps = [
    "在目标机器（任意网络位置，无需控制面反向可达）执行右侧 curl 命令",
    "脚本自动安装前置（node / opencode CLI 缺失即装）、下载 worker 发布包并安装依赖、写入配置（SERVER_URL / WORKER_ID / --token 传入的 X_WORKER_TOKEN / --advertise-host 传入的 IP 由脚本自动补全为 http://<ip> 作为 WORKER_ADVERTISE_HOST / --serve-hostname 传入的 OPENCODE_SERVE_HOSTNAME / --mcp-url 传入的 WORKER_MCP_URL），启动后向控制面注册",
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
    setWorkerId(randomWorkerId());
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
              backgroundColor: "var(--color-surface)",
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

              <FieldRow label="注册 token（workerToken）" hint="自动拉取 server WORKER_TOKEN · 可手动修改">
                <input
                  type="password"
                  data-testid="worker-token-input"
                  value={workerToken}
                  onChange={(e) => setWorkerToken(e.target.value)}
                  spellCheck={false}
                  placeholder="自动填充中…"
                  style={inputStyle}
                />
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
                <FieldRow label="opencode 版本" hint="与 worker 实际运行版本一致">
                  <select
                    value={opencodeVersion}
                    onChange={(e) => setOpencodeVersion(e.target.value)}
                    style={{ ...inputStyle, cursor: "pointer" }}
                  >
                    <option value="v1.18.15">v1.18.15（V1Runtime · 当前稳定）</option>
                    <option value="v1.18.14">v1.18.14（V1Runtime）</option>
                  </select>
                </FieldRow>
              </div>

              {/* 网络可达性（可选）：外部/跨机 worker 专用 */}
              <div style={{ display: "flex", flexDirection: "column", gap: space.md, paddingTop: space.sm, borderTop: `1px solid ${neutral[100]}` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>网络可达性（可选）</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>外部/跨机 worker 必填 · 集群内留空</span>
                </div>

                <FieldRow label="上报 IP（advertise-host）" hint="只填 IP 如 192.168.1.100，http:// 与端口自动处理；不填则 worker 自动探测本机 IP">
                  <input
                    data-testid="advertise-host-input"
                    value={advertiseHost}
                    onChange={(e) => setAdvertiseHost(e.target.value)}
                    placeholder="192.168.1.100"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </FieldRow>

                <FieldRow label="监听地址（serve-hostname）" hint="外部 worker 填 0.0.0.0 监听所有接口 · 集群内/本机留空">
                  <input
                    data-testid="serve-hostname-input"
                    value={serveHostname}
                    onChange={(e) => setServeHostname(e.target.value)}
                    placeholder="0.0.0.0"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </FieldRow>

                <FieldRow label="MCP 地址（mcp-url）" hint="默认已填当前控制面内置 MCP 入口 · 外部/集群外场景可改">
                  <input
                    data-testid="mcp-url-input"
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="http://<控制面外部地址>/api/v1/platform-mcp"
                    spellCheck={false}
                    style={inputStyle}
                  />
                </FieldRow>

                <FieldRow label="工作目录（work-dir）" hint="缺省 /tmp/keta-worker · 注入落点（opencode.json/技能/工具）；需持久化/固定目录时可设">
                  <input
                    data-testid="work-dir-input"
                    value={workDir}
                    onChange={(e) => setWorkDir(e.target.value)}
                    placeholder="/tmp/keta-worker"
                    spellCheck={false}
                    style={inputStyle}
                  />
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
                        backgroundColor: active ? "var(--color-surface)" : "transparent",
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
                          backgroundColor: active ? "rgba(37,99,235,0.10)" : neutral[100],
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
                backgroundColor: "var(--color-surface)",
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
