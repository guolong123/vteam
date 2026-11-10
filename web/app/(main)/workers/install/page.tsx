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
 * - 真实默认值（MOCK-03）：opencode 版本默认 **latest**（npm 包 @opencode/cli 的 latest 标签
 *   = 最新已发布的 v2；curl 脚本路径据此安装）。下拉里另保留两个可复现的具体版本：2.0.32
 *   （= worker/Dockerfile 的 ARG OPENCODE_CLI_SPEC 锁版，镜像路径用的就是它）与 2.0.28（实测版本）。
 *   ⚠️ 两条安装路径可能落在不同 opencode 版本上：脚本跟 latest、docker 跟镜像内置的 2.0.32；
 *   但 v1 的 npm 包 opencode-ai 已冻结在 1.19.3、永远到不了 v2，而 worker 启动期版本闸门要求
 *   主版本 ≥ 2——选 v1 会让 worker 启动即判死（安装脚本另有一道 ≥3 的硬闸，详见 install-worker.sh）；
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
 *
 * - docker 路径的镜像引用可编辑（③ 的「worker 镜像」字段，缺省 guojongg/vteam-worker:latest）：
 *   内网机器常拉不到 Docker Hub；且镜像必须是含 opencode v2 适配的构建——latest 自 v1.1.0 起已带
 *   v2 适配，v1.0.x 各 tag 仍是 v1 worker（v1 worker + v1 opencode CLI），与 v2 控制面不兼容。
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
        backgroundColor: "rgba(13,148,136,0.10)",
        color: "#0D9488",
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
              backgroundColor: "rgba(13,148,136,0.10)",
              border: "1px solid rgba(13,148,136,0.22)",
              color: "#0D9488",
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
  /* opencode 版本（curl 脚本路径）：缺省 **latest** = npm 包 @opencode/cli 的 latest 标签
     （最新已发布的 v2）——跟随上游发布，避免把裸机安装钉死在两个硬编码版本上；
     需要可复现时在下拉里选具体版本（2.0.32 = 镜像锁版 / 2.0.28 = 实测版本）。
     ⚠️ v1 的 npm 包 opencode-ai 冻结在 1.19.3（永不到 v2），worker 启动期版本闸门要求主版本 ≥ 2
     → 选 v1 会让 worker 启动即判死；≥3 会被 install-worker.sh 硬失败拦下（worker 驱动只验证过 v2）。
     ℹ️ docker 路径不受本选择影响：镜像内 opencode 由构建期 OPENCODE_CLI_SPEC 锁死为 2.0.32。 */

  /* worker 镜像（docker 路径专用）：完整镜像引用（仓库 + tag），可编辑。
     缺省 = Docker Hub 上发布流水线推送的 guojongg/vteam-worker:latest
     （.github/workflows/release-images.yml 的 IMAGE_NAMESPACE: guojongg；原写死的
     ketaops/opencode-worker 在 Docker Hub 上不存在，docker run 直接拉取失败）。
     内网机器常拉不到 Docker Hub → 需改填内网仓库（docker-hosted.ketaops.cc /
     docker-release.ketaops.cc / chart 缺省 docker.ketaops.cc），故做成可编辑字段。
     ⚠️ 镜像必须含 opencode v2 适配：latest 自 v1.1.0 起已带 v2 适配；v1.0.x 各 tag 仍是 v1 worker
     （v1 worker + v1 opencode CLI），与 v2 控制面不兼容（见 dockerSteps 的告警）⇒ 勿钉 v1.0.x tag。 */
  const [workerImage, setWorkerImage] = useState("guojongg/vteam-worker:latest");
  /** dsh 镜像（引擎选 dsh 时 docker 路径用；Dockerfile.dsh 构建，含 node 24 + dsh CLI + bubblewrap）。 */
  const [workerDshImage, setWorkerDshImage] = useState("guojongg/vteam-worker-dsh:latest");

  /* 网络可达性（可选）：外部/跨机 worker 专用，空值不拼接命令——集群内/本机无需配置 */
  const [advertiseHost, setAdvertiseHost] = useState("");
  /**
   * 执行引擎：opencode（缺省）/ dsh。dsh 需要 Node 24 + dsh CLI + bubblewrap（脚本自动装）。
   * ⚠️ **模型路由与凭据不在安装时填**：provider 的 baseUrl / 请求头 / API key 都由控制面
   * 「模型管理」统一维护，worker 启动后经凭据下发拿到（dsh 的 apiKeyEnv 机制）。
   */
  const [engine, setEngine] = useState<"opencode" | "dsh">("opencode");
  const [mcpUrl, setMcpUrl] = useState("");

  /* serverUrl 初始值：页面 origin 但端口 13001(web)→13000(server)修正——worker 须直连 server，
     跟随 web origin 会连错（compose 反代架构）；用户可手动修改 */
  useEffect(() => {
    setServerUrl((cur) => {
      if (cur) return cur;
      try {
        const u = new URL(pageOrigin);
        if (u.port === "13001") u.port = "13000";
        return u.toString().replace(/\/$/, "");
      } catch {
        return pageOrigin;
      }
    });
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
     --advertise-host 传入经 sanitizeIp 清洗的纯 IP，脚本自动补 http:// 前缀。
     docker 命令：v2 下控制面只连 worker 的**执行端点**（capabilities.execPort，缺省 4198），
     不连 opencode serve ⇒ 发布 4198:4198，serve 只在容器内用（不映射宿主机）；
     X_WORKER_TOKEN（注册鉴权）与 OPENCODE_SERVER_PASSWORD（v2 serve 恒开鉴权）均为必填，
     后者用 openssl rand 现场生成，避免把口令写死进页面。
     并发上限注入 WORKER_MAX_INSTANCES（worker 侧真实读取的变量，随注册上报 capabilities.maxInstances；
     旧的 CONCURRENCY 环境变量 worker 根本不读）；镜像引用取自「worker 镜像」字段
     （缺省 guojongg/vteam-worker:latest，可改内网仓库）。 */
  const isDsh = engine === "dsh";
  /** dsh 只需要声明引擎本身；模型路由/凭据由控制面「模型管理」下发，不在这里拼。 */
  const dshCurlArgs = "";
  const dshDockerEnv = "-e WORKER_ENGINE=dsh";

  const curlCommand = isDsh
    ? `curl -fsSL ${pageOrigin}/install-worker.sh | bash -s -- --server ${serverUrl} --engine dsh --worker-id ${workerId} --concurrency ${concurrency}${dshCurlArgs}${workerToken ? ` --token ${workerToken}` : ""}${advertiseHost ? ` --advertise-host http://${sanitizeIp(advertiseHost)}` : ""}${mcpUrl ? ` --mcp-url ${mcpUrl}` : ""}`
    : `curl -fsSL ${pageOrigin}/install-worker.sh | bash -s -- --server ${serverUrl} --worker-id ${workerId} --concurrency ${concurrency}${workerToken ? ` --token ${workerToken}` : ""}${advertiseHost ? ` --advertise-host http://${sanitizeIp(advertiseHost)}` : ""}${mcpUrl ? ` --mcp-url ${mcpUrl}` : ""}`;
  // `--init`：容器 PID1 必须当 reaper。node 直接当 PID1 时不回收 reparent 到 PID1 的
  // 孤儿孙进程 ⇒ agent-browser/Chrome 每次浏览器操作留下 ~20 个 Z 僵尸（PPID=1）。
  // 镜像内已有 tini ENTRYPOINT 双保险；这里显式加 --init，旧镜像/自定义 entrypoint 也不复发。
  const dockerCommand = isDsh
    ? `docker run -d --init --name dsh-worker-${workerId} -e SERVER_URL=${serverUrl} -e WORKER_ID=${workerId} -e WORKER_MAX_INSTANCES=${concurrency}${workerToken ? ` -e X_WORKER_TOKEN=${workerToken}` : ""} ${dshDockerEnv} -e WORKER_EXEC_PORT=4198 -p 4198:4198${advertiseHost ? ` -e WORKER_ADVERTISE_HOST=http://${sanitizeIp(advertiseHost)}` : ""} ${workerDshImage}`
    : `docker run -d --init --name opencode-worker-${workerId} -e SERVER_URL=${serverUrl} -e WORKER_ID=${workerId} -e WORKER_MAX_INSTANCES=${concurrency}${workerToken ? ` -e X_WORKER_TOKEN=${workerToken}` : ""} -e OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 32) -e WORKER_EXEC_PORT=4198 -p 4198:4198${advertiseHost ? ` -e WORKER_ADVERTISE_HOST=http://${sanitizeIp(advertiseHost)}` : ""} ${workerImage}`;

  const command = method === "curl" ? curlCommand : dockerCommand;

  const curlSteps = [
    "在目标机器执行右侧 curl 命令（无需控制面反向可达）",
    "脚本自动装 Node / opencode CLI v2，下载 worker 发布包并写 .env（含随机 serve 密码），随后注册入池",
    "控制面只拨 worker 的执行端点 <上报主机>:4198；外部机器请填写「上报 IP」",
  ];

  const curlDshSteps = [
    "在目标机器用普通用户执行命令（不要 root：bwrap 走特权路径会失败）",
    "脚本自动装 Node ≥ 24.9、dsh CLI、bubblewrap，并给全局 dsh 打「bwrap 不挂 /proc」补丁",
    "模型与凭据由控制面下发，无需填写；注册后控制面直连 <上报主机>:4198",
  ];

  const dockerSteps = [
    "先填「上报 IP」（宿主机 IP）+ SERVER_URL 不要留 127.0.0.1：否则注册成功但控制面拨不到执行端点",
    "在目标机器执行 docker run 命令（镜像需含 opencode v2 适配，≥ v1.1.0；-p 4198:4198 已含在命令里）",
    "容器读取 SERVER_URL / WORKER_ID / WORKER_MAX_INSTANCES 后注册入池",
  ];

  const dockerDshSteps = [
    "先填「上报 IP」（宿主机 IP）：容器内自动探测的是容器 IP，控制面连不上 ⇒ 会表现为注册成功但派发 fetch failed",
    "在目标机器执行 docker run 命令（镜像缺省 vteam-worker-dsh，已内置沙箱补丁）；容器需把 4198 映射到宿主机（命令里已有 -p 4198:4198）",
    "只带 WORKER_ENGINE=dsh 即可：模型与凭据由控制面下发、按任务派发",
  ];

  const steps = method === "curl" ? (isDsh ? curlDshSteps : curlSteps) : isDsh ? dockerDshSteps : dockerSteps;

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
              gap: space.lg,
              padding: `${space.xl}px`,
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

              </div>

              <FieldRow
                label="执行引擎（engine）"
                hint="opencode = 现有引擎（光/容器镜像 vteam-worker）；dsh = DeepSeek Harness 引擎（镜像 vteam-worker-dsh，需 Node ≥ 24）"
              >
                <div data-testid="engine-select" style={{ display: "flex", gap: space.sm }}>
                  {([
                    { key: "opencode" as const, label: "opencode（缺省）", desc: "opencode CLI v2" },
                    { key: "dsh" as const, label: "dsh", desc: "DeepSeek Harness" },
                  ]).map((item) => {
                    const active = engine === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        data-engine={item.key}
                        data-active={active ? "true" : "false"}
                        onClick={() => setEngine(item.key)}
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: 2,
                          padding: `${space.sm}px ${space.md}px`,
                          borderRadius: radius.md,
                          border: `1px solid ${active ? "#0D9488" : neutral[200]}`,
                          backgroundColor: active ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
                          color: active ? "#0D9488" : neutral[700],
                          fontSize: fontSize.md,
                          cursor: "pointer",
                          fontFamily: fontFamily.body,
                          textAlign: "left",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{item.label}</span>
                        <span style={{ fontSize: fontSize.xs, color: active ? "#0D9488" : neutral[400] }}>{item.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </FieldRow>

              <FieldRow label="控制面地址" hint="worker 直连 server 的地址（已自动填本机 origin）">
                <input
                  data-testid="server-url-input"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  spellCheck={false}
                  style={inputStyle}
                />
              </FieldRow>

              <FieldRow label="Worker 标识" hint="全局唯一，可改">
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

              <FieldRow label="注册 token" hint="已自动填 server WORKER_TOKEN">
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
              <FieldRow label="并发上限" hint="写入 WORKER_MAX_INSTANCES · 控制面按此调度">
                <select
                  data-testid="concurrency-select"
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

              {isDsh && (
                <div
                  data-testid="dsh-config"
                  style={{
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: neutral[50],
                    fontSize: fontSize.xs,
                    lineHeight: 1.6,
                    color: neutral[500],
                  }}
                >
                  dsh 的模型与凭据由「模型管理」下发，安装时无需填写；前提是该 provider 已配好 baseUrl 与请求头。
                </div>
              )}

              {/* 网络可达性（可选）：外部/跨机 worker 专用 */}
              <div style={{ display: "flex", flexDirection: "column", gap: space.md, paddingTop: space.sm, borderTop: `1px solid ${neutral[100]}` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>网络可达性（可选）</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>外部/跨机 worker 必填 · 集群内留空</span>
                </div>

                <FieldRow
                  label="上报 IP（advertise-host）"
                  hint={
                    method === "docker" && !advertiseHost
                      ? "⚠️ docker 安装必填：容器内自动探测到的是容器 IP，控制面连不上"
                      : "只填 IP，如 192.168.1.100（跨机 / docker 安装必填）"
                  }
                >
                  <input
                    data-testid="advertise-host-input"
                    value={advertiseHost}
                    onChange={(e) => setAdvertiseHost(e.target.value)}
                    placeholder="192.168.1.100"
                    spellCheck={false}
                    style={
                      method === "docker" && !advertiseHost
                        ? { ...inputStyle, borderColor: "rgba(217,119,6,0.55)" }
                        : inputStyle
                    }
                  />
                  {method === "docker" && !advertiseHost && (
                    <span style={{ fontSize: fontSize.xs, color: "#B45309", lineHeight: 1.6 }}>
                      容器内网卡是 eth0，自动探测上报的是容器 IP ⇒ 控制面拨不到，
                      表现为「注册成功但派发报 worker 不可用: fetch failed」。请填宿主机 IP。
                    </span>
                  )}
                </FieldRow>

                <FieldRow label="MCP 地址（mcp-url）" hint="缺省已填当前控制面内置 MCP 入口">
                  <input
                    data-testid="mcp-url-input"
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="http://<控制面外部地址>/api/v1/platform-mcp"
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
                          backgroundColor: active ? "rgba(13,148,136,0.10)" : neutral[100],
                          color: active ? "#0D9488" : neutral[400],
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

              {/* docker 路径专用：镜像引用可编辑（内网机器拉不到 Docker Hub 时改填内网仓库） */}
              {method === "docker" && (
                <FieldRow
                  label="worker 镜像"
                  hint={
                    isDsh
                      ? "dsh 引擎镜像（Dockerfile.dsh 构建：node 24 + dsh CLI + bubblewrap）· 内网可换内网仓库"
                      : "Docker Hub 缺省 guojongg/vteam-worker · 内网可换内网仓库 · 须为含 opencode v2 适配的构建（≥ v1.1.0）"
                  }
                >
                  <input
                    data-testid="worker-image-input"
                    value={isDsh ? workerDshImage : workerImage}
                    onChange={(e) => (isDsh ? setWorkerDshImage(e.target.value) : setWorkerImage(e.target.value))}
                    placeholder={isDsh ? "guojongg/vteam-worker-dsh:latest" : "guojongg/vteam-worker:latest"}
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <span style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.6 }}>
                    填完整镜像引用（仓库 + tag）。
                    {isDsh
                      ? "dsh 引擎缺省 guojongg/vteam-worker-dsh:latest（node 24 + dsh CLI + bubblewrap，已内置沙箱补丁）；内网机器改填内网仓库的 vteam-worker-dsh。"
                      : "opencode 引擎缺省 guojongg/vteam-worker:latest——发布流水线 IMAGE_NAMESPACE=guojongg 推送的命名空间；内网机器改填内网仓库 docker-hosted.ketaops.cc/ketaops/vteam-worker、docker-release.ketaops.cc/ketaops/vteam-worker（chart 缺省 docker.ketaops.cc/ketaops/vteam-worker），取目标机能拉通的那一个。镜像必须是包含 opencode v2 适配的构建。"}
                  </span>
                </FieldRow>
              )}

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
                backgroundColor: "#0D9488",
                color: "#FFFFFF",
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                boxShadow: "0 6px 16px rgba(13,148,136,.3)",
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
