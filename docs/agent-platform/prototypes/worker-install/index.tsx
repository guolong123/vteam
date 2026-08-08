/**
 * 原型：新增 Worker 安装向导（分布式 Worker 架构 · 07 篇 11.2 / 11.4）
 * =============================================
 * 对应 07 篇第 11 章分布式 Worker 架构的部署侧：新 worker 启动后读取本地配置
 * `{serverUrl, workerId, 能力声明}` 主动向控制面注册（11.2），注册即入池（11.4 水平扩容）。
 *
 * 页面内容：
 * - 两种安装方式 Tab：方式 A curl 命令安装（一键脚本下载二进制 + 注册）、
 *   方式 B docker 容器安装（ketaops/opencode-worker 镜像 + 环境变量注入）。
 * - 参数配置区（受控输入，动态拼接到命令）：serverUrl（控制面地址）、
 *   workerId（自动生成可改）、能力声明（并发上限 / opencode 版本）。
 * - 命令展示区（mono 深色底）+ 复制按钮 + 安装步骤说明（3 步）。
 * - 底部：完成 / 取消按钮 + 安装指引提示。纯静态展示（不执行真实安装/复制）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + position:relative，浮层 absolute，零 fixed / vh / vw。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import {
  neutral,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock 收起态宽度（与 _shared/nav RAIL_W 对齐），内容区避让留白 */
const RAIL_W = 56;

/** 安装方式 */
type InstallMethod = "curl" | "docker";

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「Worker 节点」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙", active: true },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "复制安装命令", icon: "⧉" },
  { group: "操作", label: "查看安装指引", icon: "▦" },
];

/* ------------------------------ 子组件 ------------------------------ */

/** 表单字段行：标签 + 说明 + 输入槽 */
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

/** 输入框统一样式 */
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

/** 命令展示区：浅色 mono 底 + 复制按钮 */
function CommandBlock({ command }: { command: string }) {
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
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs}px ${space.md}px`,
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
          color: neutral[600],
          fontSize: fontSize.sm,
          cursor: "pointer",
          fontFamily: fontFamily.body,
        }}
      >
        <span aria-hidden>⧉</span>
        复制
      </button>
    </div>
  );
}

/** 安装步骤说明条（3 步） */
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

/* ------------------------------ 页面主组件 ------------------------------ */

function WorkerInstallPage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  /* 安装方式 Tab（受控） */
  const [method, setMethod] = useState<InstallMethod>("curl");

  /* 参数配置（受控，动态拼接到命令展示） */
  const [serverUrl, setServerUrl] = useState("http://platform:8080");
  const [workerId, setWorkerId] = useState("worker-05");
  const [concurrency, setConcurrency] = useState(8);
  const [opencodeVersion, setOpencodeVersion] = useState("v2.0.0-beta.1");

  /* 两种安装方式的命令（mock，对齐任务示例） */
  const curlCommand = `curl -fsSL https://platform.example.com/install-worker.sh | bash -s -- --server ${serverUrl} --worker-id ${workerId} --concurrency ${concurrency} --opencode ${opencodeVersion}`;
  const dockerCommand = `docker run -d --name opencode-worker-${workerId} -e SERVER_URL=${serverUrl} -e WORKER_ID=${workerId} -e CONCURRENCY=${concurrency} -e OPENCODE_VERSION=${opencodeVersion} -p 18080:18080 ketaops/opencode-worker:latest`;

  const command = method === "curl" ? curlCommand : dockerCommand;

  const curlSteps = [
    "在目标机器（任意网络位置，无需控制面反向可达）执行右侧 curl 命令",
    "脚本自动下载 worker 二进制，写入配置并 POST /api/workers/register 注册",
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

  return (
    <div
      data-testid="worker-install-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
      }}
    >
      {/* 浅色顶栏 */}
      <NavTopBar
        breadcrumb={["Worker 节点管理", "新增 Worker"]}
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：居中向导卡片，左侧留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xl}px ${RAIL_W + space.xl}px`,
        }}
      >
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
                  1
                </span>
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
                  2
                </span>
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
                  3
                </span>
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

{/* 左侧 Dock 悬浮导航：activeKey="workers"（Worker 运行节点域） */}
<NavDock activeKey="workers" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "worker-install",
    name: "新增 Worker",
    group: "平台",
    description:
      "新增 Worker 安装向导：curl 命令 / docker 容器两种安装方式，参数配置（serverUrl / workerId / 能力声明）+ 命令展示 + 步骤说明",
    device: "desktop",
  },
  Component: WorkerInstallPage,
};

export default def;
