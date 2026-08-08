"use client";

/**
 * 工具注册页（Phase 5 T5：原型保真迁移 · tool-register）
 * =====================================================
 * 保真迁移自 docs/agent-platform/prototypes/tool-register/index.tsx（平台侧登记工具 manifest）。
 * 导航由 AppShell（app/(main)/layout.tsx）提供（NavTopBar + NavDock + CmdKPanel），本页仅渲染内容区。
 *
 * 核心概念模型（原型头注，用户澄清）：
 *   ① 输入 Schema：code / cli / http 统一声明「模型怎么调」（模型靠它知道传什么参数）；
 *      mcp 例外：server 自带 schema，无需配置。
 *   ② 执行绑定：仅 cli / http（可选）——把输入参数拼进 CLI 命令占位符 / HTTP 请求位置，
 *      是执行期细节，模型无感知；code / mcp 无此步骤。
 *   ③ 初始化命令/脚本：worker 节点在首次执行该工具前运行，完成环境准备
 *      （平台不自动推断二进制依赖，命令由工具注册者自行填写）。
 *
 * 5 区块表单：① 基础信息（名称/描述/版本/角色绑定）→ ② 执行方式（4 种执行形态受控联动：
 * 平台代码 / CLI 封装（Schema 化 ↔ 自由调用双模式）/ HTTP 回调 / MCP 接入（Local ↔ Remote））
 * → ③ 输入/输出 Schema 统一区 → ④ 执行绑定（按类型动态）→ ⑤ 初始化命令/脚本。
 * CLI 封装含两个互斥子模式（cli-mode-select）：Schema 化调用（默认，定义输入 Schema +
 * 参数映射，类型安全）/ 自由调用（平台自动生成极简 {command} schema —— 与 opencode bash
 * 工具同模式，符合工具协议：input schema 必填，模型像 bash 一样自由传命令字符串）。
 * MCP 语义：工具通过连接 MCP server 获取（本地进程 / 远程服务），暴露的工具注册为
 * <server>_<tool> 进入 opencode 工具命名空间。
 *
 * 数据对接（Phase 5 接线）：ToolsModule 已落地 → 注册按钮真实提交
 *   POST /api/v1/tools（载荷对齐 CreateToolDto：name/action/execution/mcpServer/
 *   schema/initCommand/enabled，无独立 source 入参——后端按 execution 推导：mcp→mcp，其余→custom），
 *   成功显示反馈并可在「技能/工具」页面查看；
 *   action 由工具名推导（小写 slug），冲突 → 409 TOOL_ACTION_EXISTS 反馈错误。
 *
 * 铁律：T15 root = flex:1 + minHeight:0 + position:relative + overflowY:auto（零 fixed/vh/vw）；
 * T21 Schema/命令/参数映射一律浅色（neutral[100] 底 + neutral[800] 字，勿黑底）。
 * data-testid 与原型完全一致（56 个，全站最多），清单见 .omo/evidence/prototype-audit.md §2.10。
 */
import { useState, type CSSProperties } from "react";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import {
  neutral,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
  type RoleKey,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ mock 数据（对齐原型） ------------------------------ */

/** 初始化命令/脚本：工具执行前由 worker 节点运行，完成环境准备（如安装二进制、配置凭据）。
 * 平台不自动推断二进制依赖，命令内容由工具注册者自行填写。 */
interface InitCommand {
  id: string;
  /** 命令/脚本内容（支持多行 shell 脚本，首行可用 # 注释说明） */
  script: string;
  /** 说明（可选）：该命令准备什么环境 */
  note: string;
}

/** 默认预填一个示例初始化命令（安装 jcli = Jenkins CLI） */
const DEFAULT_INIT_COMMAND: InitCommand = {
  id: "cmd-default",
  script: "# 安装 jcli（Jenkins CLI）\ncurl -fsSL https://example.com/install-jcli.sh | bash",
  note: "工具依赖 Jenkins CLI，worker 首次执行前安装",
};

/* ------------------------------ 执行方式（4 种执行形态） ------------------------------
 * 工具 = 声明（schema）+ 执行（handler）两部分：schema 是接口声明（模型知道怎么调），
 * 执行方式是实际干活的部分。4 种形态：平台代码（内置 execute）/ CLI 封装（拼命令）/
 * HTTP 回调（转发端点）/ MCP 接入（连接 MCP server 获取，本地进程或远程服务，
 * 暴露的工具注册为 <server>_<tool> 进入 opencode 工具命名空间）。
 */
type ExecType = "code" | "cli" | "http" | "mcp";

/** 平台代码执行示例（readOnly 编辑器占位内容，纯展示不执行） */
const HANDLER_CODE_EXAMPLE = `export async function execute(input: Input, ctx: ToolContext) {
  // 调平台 API：按输入 jobName 查询构建任务
  const build = await ctx.api.query("ci", {
    jobName: input.jobName,
    buildNumber: input.buildNumber,
  });
  return { status: build.status, buildNumber: build.number };
}`;

const execTypes: { key: ExecType; label: string; icon: string; desc: string }[] = [
  { key: "code", label: "平台代码", icon: "⌘", desc: "内置 execute · 调平台 API / DB" },
  { key: "cli", label: "CLI 封装", icon: "⌥", desc: "args 拼 CLI 命令执行" },
  { key: "http", label: "HTTP 回调", icon: "↗", desc: "转发到 webhook / API" },
  { key: "mcp", label: "MCP 接入", icon: "▣", desc: "连接 MCP server · 工具注册为 <server>_<tool>" },
];

/* ------------------------------ Schema / 执行绑定 mock（对齐原型） ------------------------------ */

/** 统一输入 Schema 示例（readOnly 编辑器占位，code/cli/http 共用，JSON Schema 格式） */
const INPUT_SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "jobName": { "type": "string", "description": "任务名" },
    "buildNumber": { "type": "integer", "description": "构建号" }
  },
  "required": ["jobName"]
}`;

/** 输出 Schema 示例（可选，readOnly 编辑器占位，JSON Schema 格式） */
const OUTPUT_SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "status": { "type": "string" },
    "buildNumber": { "type": "integer" }
  }
}`;

/** CLI 自由调用：平台自动生成的极简输入 Schema（只读展示，与 opencode bash 工具同模式）。
 * opencode 工具强制要求 input schema（v2 Tool.make 的 input 必填、v1 tool() 的 args 必填），
 * bash 工具即 Schema.Struct({ command: String }) ——「自由调用」= 极简 {command} schema，
 * 模型像 bash 一样自由传命令字符串（执行时追加到命令前缀后）。 */
const CLI_FREE_SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "模型自由构造的命令字符串（执行时追加到前缀后）"
    }
  },
  "required": ["command"]
}`;

/** CLI 执行绑定：参数 → 命令占位符 {{arg}}（参数名来自输入 Schema） */
const cliArgMap = [
  { id: "arg-jobName", arg: "jobName", placeholder: "{{jobName}}", desc: "任务名" },
  { id: "arg-buildNumber", arg: "buildNumber", placeholder: "{{buildNumber}}", desc: "构建号" },
] as const;

/** HTTP 执行绑定：参数 → 请求位置 query / body / path（参数名来自输入 Schema） */
const httpParams = [
  { id: "param-jobName", arg: "jobName", location: "query" as const, desc: "URL 查询参数" },
  { id: "param-buildNumber", arg: "buildNumber", location: "body" as const, desc: "请求体字段" },
] as const;

/** HTTP 位置可选值（query / body / path） */
const HTTP_LOCATIONS = ["query", "body", "path"] as const;

/** CLI 自由调用说明文案（两处共用：配置区 + Schema 区） */
const CLI_FREE_NOTE = (
  <>
    使用自动生成的极简{" "}
    <code
      style={{
        fontFamily: fontFamily.mono,
        color: neutral[800],
        backgroundColor: neutral[100],
        padding: "1px 6px",
        borderRadius: radius.sm,
      }}
    >
      {"{command}"}
    </code>{" "}
    schema（与 <strong style={{ color: "#2563EB", fontWeight: 600 }}>opencode bash 工具</strong>
    同模式，符合工具协议 —— input schema 必填），模型像 bash 一样自由传命令字符串；
    适合通用 CLI 探索与快速接入。
  </>
);

/* ------------------------------ 子组件（对齐原型） ------------------------------ */

/** 表单字段行：标签 + 说明 + 输入槽（对齐 worker-install FieldRow） */
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

/** 输入框统一样式（浅色主题，T21：非黑底） */
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

/** 编号圆点（①②③ 步骤） */
function StepNum({ n }: { n: number }) {
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
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}

/** 受控切换 tab（执行形态 / CLI 模式 / MCP 类型 共用骨架：激活项白底 + sm 阴影） */
function ModeTab({
  active,
  icon,
  label,
  desc,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: fontSize.md,
            fontWeight: 600,
            color: active ? neutral[900] : neutral[600],
          }}
        >
          {label}
        </span>
        <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
          {desc}
        </span>
      </span>
    </button>
  );
}

/** 单条初始化命令卡片：命令/脚本 textarea（浅色 T21）+ 说明输入 + 删除按钮 */
function InitCommandRow({
  cmd,
  index,
  onScriptChange,
  onNoteChange,
  onRemove,
}: {
  cmd: InitCommand;
  index: number;
  onScriptChange: (v: string) => void;
  onNoteChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <div
      data-testid="init-command-item"
      data-index={index}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.md}px ${space.lg}px`,
        borderRadius: radius.md,
        backgroundColor: neutral[50],
        border: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 头行：编号 + 删除按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <span
          style={{
            fontSize: fontSize.sm,
            fontWeight: 600,
            color: neutral[600],
            fontFamily: fontFamily.mono,
          }}
        >
          初始化命令 #{index + 1}
        </span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
          多行 shell 脚本 · worker 首次执行工具前运行
        </span>
        <button
          type="button"
          data-testid="remove-init-command"
          data-index={index}
          onClick={onRemove}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm + 2}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[500],
            fontSize: fontSize.sm,
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden>✕</span>
          删除
        </button>
      </div>

      {/* 命令/脚本内容：textarea 多行，浅色主题（T21：neutral[100] 底 + neutral[800] 字） */}
      <textarea
        data-testid="init-command-input"
        data-index={index}
        value={cmd.script}
        onChange={(e) => onScriptChange(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={"# 注释说明\n<初始化命令或脚本，如安装二进制 / 配置凭据>"}
        style={{
          ...inputStyle,
          fontFamily: fontFamily.mono,
          resize: "vertical",
          lineHeight: 1.7,
          backgroundColor: neutral[100],
        }}
      />

      {/* 说明（可选） */}
      <input
        data-testid="init-command-note"
        data-index={index}
        value={cmd.note}
        onChange={(e) => onNoteChange(e.target.value)}
        spellCheck={false}
        placeholder="说明（可选）：该命令准备什么环境…"
        style={inputStyle}
      />
    </div>
  );
}

/* ------------------------------ 页面主组件 ------------------------------ */

export default function ToolRegisterPage() {
  /* 基础信息（受控，动态联动输入） */
  const [toolName, setToolName] = useState("jira-query");
  const [toolDesc, setToolDesc] = useState("按关键词查询 Jira 工单并返回结构化结果");
  const [version, setVersion] = useState("v1.4.0");

  /* 绑定角色（受控多选：点击切换勾选态，data-bound 联动） */
  const allRoles: RoleKey[] = ["product", "architect", "developer", "tester"];
  const [boundRoles, setBoundRoles] = useState<RoleKey[]>(["product", "developer", "tester"]);
  const toggleRole = (r: RoleKey) =>
    setBoundRoles((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
    );

  /* 初始化命令/脚本列表（受控，默认预填一个示例初始化命令） */
  const [initCommands, setInitCommands] = useState<InitCommand[]>([DEFAULT_INIT_COMMAND]);
  const addInitCommand = () =>
    setInitCommands((prev) => [
      ...prev,
      { id: `cmd-${Date.now()}`, script: "", note: "" },
    ]);
  const removeInitCommand = (id: string) =>
    setInitCommands((prev) => prev.filter((c) => c.id !== id));
  const updateInitScript = (id: string, v: string) =>
    setInitCommands((prev) => prev.map((c) => (c.id === id ? { ...c, script: v } : c)));
  const updateInitNote = (id: string, v: string) =>
    setInitCommands((prev) => prev.map((c) => (c.id === id ? { ...c, note: v } : c)));

  /* 已配置（脚本非空）的初始化命令条数：CLI / MCP 联动提示依据 */
  const configuredInitCount = initCommands.filter((c) => c.script.trim().length > 0).length;

  /* 执行方式（受控，4 种执行形态联动切换） */
  const [execType, setExecType] = useState<ExecType>("code");

  /* CLI 封装调用模式（互斥切换，Schema 化默认）：
   * schema=定义输入 Schema + 参数映射（类型安全）；free=平台自动生成极简 {command}
   * schema（与 opencode bash 工具同模式，符合工具协议 —— input schema 必填），
   * 模型像 bash 一样自由传命令字符串。 */
  const [cliMode, setCliMode] = useState<"schema" | "free">("schema");
  const [cliCommand, setCliCommand] = useState("jcli issue get {{jobName}} --limit {{buildNumber}}");
  const [cliOutput, setCliOutput] = useState<"json" | "text">("json");
  /* 自由调用模式配置：命令前缀 + 白名单 + 执行约束（超时 / 工作目录） */
  const [cliFreeCommand, setCliFreeCommand] = useState("jcli ");
  const [cliFreeWhitelist, setCliFreeWhitelist] = useState("job search\nplugin list");
  const [cliFreeTimeout, setCliFreeTimeout] = useState("60s");
  const [cliFreeCwd, setCliFreeCwd] = useState("");
  const [httpUrl, setHttpUrl] = useState("https://hooks.example.com/tools/jira-query");
  const [httpMethod, setHttpMethod] = useState<"POST" | "GET" | "PUT">("POST");
  const [httpOutput, setHttpOutput] = useState<"json" | "text">("json");

  /* HTTP 执行绑定：参数 → 请求位置（query / body / path，受控 select，来自输入 Schema 的参数） */
  const [httpLocs, setHttpLocs] = useState<Record<string, "query" | "body" | "path">>({
    jobName: "query",
    buildNumber: "body",
  });

  /* MCP 接入配置（受控，对齐 mcp-register 的 Local/Remote 两套 schema） */
  const [mcpType, setMcpType] = useState<"local" | "remote">("local");
  const [mcpCommand, setMcpCommand] = useState(
    "npx -y @modelcontextprotocol/server-filesystem /data",
  );
  const [mcpCwd, setMcpCwd] = useState("/data");
  const [mcpEnv, setMcpEnv] = useState("DATA_ROOT=/data\nLOG_LEVEL=info");
  const [mcpUrl, setMcpUrl] = useState("https://mcp.example.com/jira");
  const [mcpHeaders, setMcpHeaders] = useState(
    "Authorization: Bearer {{token}}\nContent-Type: application/json",
  );
  const [mcpOauth, setMcpOauth] = useState(false);

  /* 注册结果：idle=未提交 / error=校验或 API 失败 / success=POST /tools 成功。
   * registerError 承载具体失败文案（校验失败 / API 业务错误分开展示）。 */
  const [registerState, setRegisterState] = useState<"idle" | "error" | "success">("idle");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  /** action 规范（对齐 CreateToolDto @Matches：小写字母/数字/连字符/下划线/点开头） */
  const ACTION_RE = /^[a-z0-9][a-z0-9-_.]*$/;

  const handleRegister = async () => {
    /* 最小校验：工具名必填（其余字段均有默认值/示例占位） */
    const name = toolName.trim();
    if (!name) {
      setRegisterState("error");
      setRegisterError("注册失败：工具名不能为空，请填写工具名（标识符）。");
      return;
    }
    /* action 由工具名推导（小写 + 空格转连字符）；不符合 slug 规范则前端拦截 */
    const action = name.toLowerCase().replace(/\s+/g, "-");
    if (!ACTION_RE.test(action)) {
      setRegisterState("error");
      setRegisterError(
        "注册失败：工具名需为小写字母/数字/连字符（action 规范，如 jira-query），当前无法生成合法调用标识。",
      );
      return;
    }
    /* 输入 Schema：code/cli(schema)/http 解析示例 JSON；cli 自由调用用自动生成极简 schema；
     * mcp 由 server 自带 schema 不传 */
    let schema: Record<string, unknown> | undefined;
    if (execType !== "mcp") {
      const raw =
        execType === "cli" && cliMode === "free" ? CLI_FREE_SCHEMA_EXAMPLE : INPUT_SCHEMA_EXAMPLE;
      try {
        schema = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        schema = undefined;
      }
    }
    setRegistering(true);
    setRegisterState("idle");
    setRegisterError(null);
    try {
      await api.post("/tools", {
        name,
        action,
        execution: execType,
        mcpServer:
          execType === "mcp"
            ? (mcpType === "local" ? mcpCommand.trim().split(/\s+/)[0] ?? null : mcpUrl)
            : undefined,
        schema,
        initCommand: initCommands
          .filter((c) => c.script.trim().length > 0)
          .map((c) => ({ script: c.script, note: c.note })),
        enabled: true,
      });
      setRegisterState("success");
    } catch (err) {
      setRegisterState("error");
      setRegisterError(
        isApiError(err) ? `注册失败：${err.message}` : "注册失败：网络异常，请稍后重试",
      );
    } finally {
      setRegistering(false);
    }
  };

  const ROLE_LABEL: Record<RoleKey, string> = {
    product: "产品经理",
    architect: "架构师",
    developer: "开发者",
    tester: "测试",
  };

  return (
    <div
      data-testid="tool-register-root"
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
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: space.xl,
        }}
      >
        {/* 注册表单卡片 */}
        <div
          data-testid="tool-register-card"
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
          {/* ① 基础信息 */}
          <section
            data-testid="tool-basic-section"
            style={{ display: "flex", flexDirection: "column", gap: space.md }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <StepNum n={1} />
              <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                基础信息
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                工具 manifest：名称 / 描述 / 版本 / 角色绑定
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: space.md }}>
              <FieldRow label="工具名（标识符）" hint="mono 标识，分发与引用使用">
                <input
                  data-testid="tool-name-input"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  spellCheck={false}
                  style={inputStyle}
                />
              </FieldRow>
              <FieldRow label="版本">
                <select
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  style={{ ...inputStyle, cursor: "pointer" }}
                >
                  <option value="v1.4.0">v1.4.0</option>
                  <option value="v2.0.0">v2.0.0</option>
                </select>
              </FieldRow>
            </div>

            <FieldRow label="描述" hint="供 Agent 理解工具用途">
              <textarea
                data-testid="tool-desc-input"
                value={toolDesc}
                onChange={(e) => setToolDesc(e.target.value)}
                rows={2}
                spellCheck={false}
                style={{
                  ...inputStyle,
                  fontFamily: fontFamily.body,
                  resize: "none",
                  lineHeight: 1.6,
                }}
              />
            </FieldRow>

            {/* 绑定角色：多选 AgentBadge（受控勾选态） */}
            <FieldRow label="绑定角色" hint="可多选 · 分发时注入对应角色 Agent">
              <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                {allRoles.map((r) => {
                  const bound = boundRoles.includes(r);
                  return (
                    <span
                      key={r}
                      data-testid="role-bind"
                      data-role={r}
                      data-bound={bound ? "true" : "false"}
                      onClick={() => toggleRole(r)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: space.xs,
                        padding: `${space.xs}px ${space.sm}px`,
                        borderRadius: radius.pill,
                        backgroundColor: bound ? roleText[r] + "14" : neutral[100],
                        border: `1px solid ${bound ? roleText[r] + "40" : neutral[200]}`,
                        color: bound ? roleText[r] : neutral[400],
                        fontSize: fontSize.sm,
                        fontWeight: 500,
                        cursor: "pointer",
                        userSelect: "none",
                        ...baseFont,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: fontSize.xs }}>
                        {bound ? "✓" : "○"}
                      </span>
                      {ROLE_LABEL[r]}
                    </span>
                  );
                })}
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  已选 {boundRoles.length} 个角色
                </span>
              </div>
            </FieldRow>
          </section>

          {/* ② 执行方式 */}
          <section
            data-testid="execution-section"
            style={{ display: "flex", flexDirection: "column", gap: space.md }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <StepNum n={2} />
              <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                执行方式
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                定义工具被调用后如何执行（schema 是接口声明，执行逻辑是实际干活的部分）
              </span>
            </div>

            {/* 说明条：schema 是接口声明 vs 执行方式是实际干活 */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: space.sm,
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                backgroundColor: "#EFF6FF",
                border: `1px solid #BFDBFE`,
                fontSize: fontSize.sm,
                color: neutral[600],
                lineHeight: 1.6,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⚙</span>
              <span>
                <strong style={{ color: "#2563EB", fontWeight: 600 }}>schema 是接口声明</strong>
                （模型知道怎么调）；<strong style={{ color: "#2563EB", fontWeight: 600 }}>执行方式是实际干活的部分</strong>
                （真正执行逻辑）—— 只有 schema 没有执行逻辑的工具无法工作。
              </span>
            </div>

            {/* 执行类型选择（受控 tab，仿 install-method-tab 联动） */}
            <div
              data-testid="execution-type-list"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: space.sm,
                padding: space.xs,
                borderRadius: radius.lg,
                backgroundColor: neutral[100],
              }}
            >
              {execTypes.map((t) => (
                <span
                  key={t.key}
                  data-testid="execution-type"
                  data-exec-type={t.key}
                  data-active={execType === t.key ? "true" : "false"}
                >
                  <ModeTab
                    active={execType === t.key}
                    icon={t.icon}
                    label={t.label}
                    desc={t.desc}
                    onClick={() => setExecType(t.key)}
                  />
                </span>
              ))}
            </div>

            {/* 受控联动配置面板：按执行类型展示对应配置项 */}
            <div
              data-testid="execution-config-panel"
              data-exec-type={execType}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.md,
                padding: `${space.lg}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
              }}
            >
              {/* 2a. 平台代码：handler 代码编辑器占位 */}
              {execType === "code" && (
                <>
                  <FieldRow label="处理函数（handler / execute）" hint="平台内置或上传的 execute 代码 · 可调平台 API / DB">
                    <textarea
                      data-testid="handler-code-editor"
                      readOnly
                      rows={7}
                      spellCheck={false}
                      value={HANDLER_CODE_EXAMPLE}
                      style={{
                        ...inputStyle,
                        fontFamily: fontFamily.mono,
                        resize: "none",
                        lineHeight: 1.7,
                        backgroundColor: neutral[100],
                        cursor: "default",
                      }}
                    />
                  </FieldRow>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.xs, color: neutral[400] }}>
                    <span aria-hidden>⌘</span>
                    平台侧直接调用工具 API 或数据库，worker 无需额外二进制依赖
                  </div>
                </>
              )}

              {/* 2b. CLI 封装：Schema 化 / 自由调用 两个子模式（互斥切换，Schema 化默认）+ 初始化命令联动 */}
              {execType === "cli" && (
                <>
                  {/* CLI 调用模式选择：Schema 化（类型安全）/ 自由调用（Schema-less，像 bash 一样） */}
                  <FieldRow label="调用模式" hint="Schema 化=定义 Schema+参数映射 / 自由调用=自动生成极简 {command} schema，模型自由传命令字符串">
                    <div
                      data-testid="cli-mode-select"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: space.sm,
                        padding: space.xs,
                        borderRadius: radius.lg,
                        backgroundColor: neutral[100],
                      }}
                    >
                      {(
                        [
                          { key: "schema", label: "Schema 化调用", icon: "◈", desc: "定义 Schema + 参数映射 · 类型安全" },
                          { key: "free", label: "自由调用", icon: "⌥", desc: "自动生成 {command} schema · 像 bash 一样自由传命令" },
                        ] as const
                      ).map((t) => (
                        <span
                          key={t.key}
                          data-testid={t.key === "schema" ? "cli-mode-schema" : "cli-mode-free"}
                          data-active={cliMode === t.key ? "true" : "false"}
                        >
                          <ModeTab
                            active={cliMode === t.key}
                            icon={t.icon}
                            label={t.label}
                            desc={t.desc}
                            onClick={() => setCliMode(t.key)}
                          />
                        </span>
                      ))}
                    </div>
                  </FieldRow>

                  {/* Schema 化：命令模板（{{arg}} 占位符由下方「执行绑定」区映射，模型无感知） */}
                  {cliMode === "schema" ? (
                    <FieldRow label="命令模板" hint="{{arg}} 引用输入参数 · worker 节点 shell 执行">
                      <input
                        data-testid="cli-command-template"
                        value={cliCommand}
                        onChange={(e) => setCliCommand(e.target.value)}
                        spellCheck={false}
                        style={{ ...inputStyle, backgroundColor: neutral[100] }}
                      />
                    </FieldRow>
                  ) : (
                    /* 自由调用：平台自动生成极简 {command} schema（与 opencode bash 工具同模式，
                       符合工具协议 —— v2 Tool.make 的 input 必填），模型像 bash 一样自由传命令字符串 */
                    <div
                      data-testid="cli-free-config"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: space.md,
                        padding: `${space.md}px ${space.lg}px`,
                        borderRadius: radius.md,
                        backgroundColor: "#FFFFFF",
                        border: `1px solid ${neutral[200]}`,
                      }}
                    >
                      {/* 说明文案 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: space.sm,
                          padding: `${space.md}px ${space.lg}px`,
                          borderRadius: radius.md,
                          backgroundColor: "#EFF6FF",
                          border: `1px solid #BFDBFE`,
                          fontSize: fontSize.sm,
                          color: neutral[600],
                          lineHeight: 1.6,
                        }}
                      >
                        <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⌥</span>
                        <span>{CLI_FREE_NOTE}</span>
                      </div>

                      {/* 命令模板 / 前缀：固定前缀，模型传的字符串追加在其后 */}
                      <FieldRow label="命令模板 / 前缀" hint="固定前缀，模型传的字符串追加在其后">
                        <input
                          data-testid="cli-free-command"
                          value={cliFreeCommand}
                          onChange={(e) => setCliFreeCommand(e.target.value)}
                          spellCheck={false}
                          style={{ ...inputStyle, backgroundColor: neutral[100] }}
                        />
                      </FieldRow>

                      {/* 允许的命令白名单（可选）：限制模型可执行的子命令，每行一个；留空=全允许 */}
                      <FieldRow label="允许的命令白名单" hint="可选 · 每行一个 · 留空=全允许">
                        <textarea
                          data-testid="cli-free-whitelist"
                          value={cliFreeWhitelist}
                          onChange={(e) => setCliFreeWhitelist(e.target.value)}
                          rows={3}
                          spellCheck={false}
                          placeholder={"job search\nplugin list\n# 留空 = 全允许"}
                          style={{
                            ...inputStyle,
                            fontFamily: fontFamily.mono,
                            resize: "vertical",
                            lineHeight: 1.7,
                            backgroundColor: neutral[100],
                          }}
                        />
                      </FieldRow>

                      {/* 执行约束：超时 + 工作目录（可选） */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                        <FieldRow label="执行超时" hint="worker 侧超时限制">
                          <input
                            data-testid="cli-free-timeout"
                            value={cliFreeTimeout}
                            onChange={(e) => setCliFreeTimeout(e.target.value)}
                            spellCheck={false}
                            style={inputStyle}
                          />
                        </FieldRow>
                        <FieldRow label="工作目录（cwd）" hint="可选 · 命令执行目录">
                          <input
                            data-testid="cli-free-cwd"
                            value={cliFreeCwd}
                            onChange={(e) => setCliFreeCwd(e.target.value)}
                            spellCheck={false}
                            style={inputStyle}
                          />
                        </FieldRow>
                      </div>

                      {/* 提示：模型会看到说明与白名单，自由构造命令；worker 执行时追加到前缀后运行 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: space.sm,
                          padding: `${space.sm}px ${space.md}px`,
                          borderRadius: radius.md,
                          backgroundColor: neutral[100],
                          border: `1px solid ${neutral[200]}`,
                          fontSize: fontSize.xs,
                          color: neutral[400],
                          lineHeight: 1.5,
                        }}
                      >
                        <span aria-hidden>◷</span>
                        模型会看到说明与白名单，自由构造命令；worker 执行时追加到前缀后运行
                      </div>
                    </div>
                  )}

                  {/* CLI 与初始化区联动：未配置初始化命令时提示（两种调用模式共用，平台不自动推断二进制） */}
                  {configuredInitCount === 0 ? (
                    <div
                      data-testid="cli-init-hint"
                      data-ready="false"
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: space.sm,
                        padding: `${space.md}px ${space.lg}px`,
                        borderRadius: radius.md,
                        backgroundColor: "#FFFBEB",
                        border: `1px solid #FDE68A`,
                        color: "#D97706",
                        fontSize: fontSize.sm,
                        lineHeight: 1.6,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⚠️</span>
                      <span>
                        初始化命令未配置 —— 请配置初始化命令以准备 jcli 等环境
                        （如安装二进制、配置凭据），worker 首次执行工具前先运行。
                      </span>
                    </div>
                  ) : (
                    <div
                      data-testid="cli-init-hint"
                      data-ready="true"
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: space.sm,
                        padding: `${space.md}px ${space.lg}px`,
                        borderRadius: radius.md,
                        backgroundColor: "#EFF6FF",
                        border: `1px solid #BFDBFE`,
                        color: "#2563EB",
                        fontSize: fontSize.sm,
                        lineHeight: 1.6,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⚙</span>
                      <span>
                        已配置{" "}
                        <strong style={{ color: "#2563EB", fontWeight: 600 }}>
                          {configuredInitCount}
                        </strong>{" "}
                        条初始化命令 —— worker 首次执行工具前自动运行，完成环境准备（与下方初始化区呼应）。
                      </span>
                    </div>
                  )}
                </>
              )}

              {/* 2c. HTTP 回调：URL + 方法 + 认证说明 */}
              {execType === "http" && (
                <>
                  <FieldRow label="回调 URL" hint="工具调用时转发到该端点">
                    <input
                      data-testid="http-callback-url"
                      value={httpUrl}
                      onChange={(e) => setHttpUrl(e.target.value)}
                      spellCheck={false}
                      style={{ ...inputStyle, backgroundColor: neutral[100] }}
                    />
                  </FieldRow>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: space.md }}>
                    <FieldRow label="请求方法">
                      <select
                        value={httpMethod}
                        onChange={(e) => setHttpMethod(e.target.value as "POST" | "GET" | "PUT")}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        <option value="POST">POST</option>
                        <option value="GET">GET</option>
                        <option value="PUT">PUT</option>
                      </select>
                    </FieldRow>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.sm}px ${space.md}px`,
                        borderRadius: radius.md,
                        backgroundColor: neutral[100],
                        border: `1px solid ${neutral[200]}`,
                        fontSize: fontSize.xs,
                        color: neutral[400],
                        lineHeight: 1.5,
                      }}
                    >
                      <span aria-hidden>🔐</span>
                      认证：平台以工具绑定的凭据注入 Authorization 头（Bearer / Basic）
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.xs, color: neutral[400] }}>
                    <span aria-hidden>↗</span>
                    请求体 = 工具输入 args 的 JSON 序列化；响应按 2xx / 非 2xx 映射成功与失败
                  </div>
                </>
              )}

              {/* 2d. MCP 接入：Local / Remote 受控切换（吸收 mcp-register 配置能力） */}
              {execType === "mcp" && (
                <>
                  {/* MCP 类型选择：Local 本地 / Remote 远程 */}
                  <FieldRow label="MCP 类型" hint="Local=worker 节点按配置启动本地进程 / Remote=直连远程服务">
                    <div
                      data-testid="mcp-type-select"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: space.sm,
                        padding: space.xs,
                        borderRadius: radius.lg,
                        backgroundColor: neutral[100],
                      }}
                    >
                      {(
                        [
                          { key: "local", label: "Local 本地", icon: "▣", desc: "command + cwd + env" },
                          { key: "remote", label: "Remote 远程", icon: "↗", desc: "url + headers + oauth" },
                        ] as const
                      ).map((t) => (
                        <span
                          key={t.key}
                          data-testid="mcp-type-option"
                          data-type={t.key}
                          data-active={mcpType === t.key ? "true" : "false"}
                        >
                          <ModeTab
                            active={mcpType === t.key}
                            icon={t.icon}
                            label={t.label}
                            desc={t.desc}
                            onClick={() => setMcpType(t.key)}
                          />
                        </span>
                      ))}
                    </div>
                  </FieldRow>

                  {mcpType === "local" ? (
                    <>
                      <FieldRow label="MCP 命令" hint="command[] · 空格分隔参数逐项拆分">
                        <input
                          data-testid="mcp-command-input"
                          value={mcpCommand}
                          onChange={(e) => setMcpCommand(e.target.value)}
                          spellCheck={false}
                          style={{ ...inputStyle, backgroundColor: neutral[100] }}
                        />
                      </FieldRow>
                      <FieldRow label="工作目录（cwd）" hint="启动命令的工作目录">
                        <input
                          data-testid="mcp-cwd-input"
                          value={mcpCwd}
                          onChange={(e) => setMcpCwd(e.target.value)}
                          spellCheck={false}
                          style={inputStyle}
                        />
                      </FieldRow>
                      <FieldRow label="环境变量（environment）" hint="简化 · key=value 每行一条">
                        <textarea
                          data-testid="mcp-env-input"
                          value={mcpEnv}
                          onChange={(e) => setMcpEnv(e.target.value)}
                          rows={2}
                          spellCheck={false}
                          style={{
                            ...inputStyle,
                            fontFamily: fontFamily.mono,
                            resize: "none",
                            lineHeight: 1.6,
                          }}
                        />
                      </FieldRow>

                      {/* Local 初始化联动：平台不自动推断二进制，需 npx/bun 等运行时请自行在初始化区配置 */}
                      <div
                        data-testid="mcp-init-hint"
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: space.sm,
                          padding: `${space.md}px ${space.lg}px`,
                          borderRadius: radius.md,
                          backgroundColor: "#EFF6FF",
                          border: `1px solid #BFDBFE`,
                          color: "#2563EB",
                          fontSize: fontSize.sm,
                          lineHeight: 1.6,
                        }}
                      >
                        <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⚙</span>
                        <span>
                          启动 MCP 命令若需要 npx / bun 等运行时，请在下方「初始化命令 / 脚本」区
                          自行配置安装脚本 —— 平台不自动推断二进制，由工具注册者填写。
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <FieldRow label="服务 URL" hint="远程 MCP 服务器地址">
                        <input
                          data-testid="mcp-url-input"
                          value={mcpUrl}
                          onChange={(e) => setMcpUrl(e.target.value)}
                          spellCheck={false}
                          style={{ ...inputStyle, backgroundColor: neutral[100] }}
                        />
                      </FieldRow>
                      <FieldRow label="Headers" hint="简化 · key: value 每行一条">
                        <textarea
                          data-testid="mcp-headers-input"
                          value={mcpHeaders}
                          onChange={(e) => setMcpHeaders(e.target.value)}
                          rows={2}
                          spellCheck={false}
                          style={{
                            ...inputStyle,
                            fontFamily: fontFamily.mono,
                            resize: "none",
                            lineHeight: 1.6,
                          }}
                        />
                      </FieldRow>
                      <FieldRow label="OAuth 认证" hint="连接时按 OAuth 流程换取访问令牌">
                        <button
                          type="button"
                          data-testid="mcp-oauth-toggle"
                          data-on={mcpOauth ? "true" : "false"}
                          onClick={() => setMcpOauth((v) => !v)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: space.sm,
                            padding: `${space.xs}px ${space.md}px`,
                            borderRadius: radius.pill,
                            border: `1px solid ${mcpOauth ? "#BFDBFE" : neutral[200]}`,
                            backgroundColor: mcpOauth ? "#EFF6FF" : neutral[50],
                            cursor: "pointer",
                            fontFamily: fontFamily.body,
                            alignSelf: "flex-start",
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 26,
                              height: 16,
                              borderRadius: radius.pill,
                              backgroundColor: mcpOauth ? "#2563EB" : neutral[300],
                              position: "relative",
                              transition: "background-color .15s ease",
                              flexShrink: 0,
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                position: "absolute",
                                top: 2,
                                left: mcpOauth ? 12 : 2,
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor: "#FFFFFF",
                                transition: "left .15s ease",
                              }}
                            />
                          </span>
                          <span
                            style={{
                              fontSize: fontSize.md,
                              fontWeight: 500,
                              color: mcpOauth ? "#2563EB" : neutral[500],
                            }}
                          >
                            {mcpOauth ? "已开启" : "已关闭"}
                          </span>
                        </button>
                      </FieldRow>
                    </>
                  )}

                  {/* MCP 命名空间提示 */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: space.sm,
                      padding: `${space.md}px ${space.lg}px`,
                      borderRadius: radius.md,
                      backgroundColor: "#EFF6FF",
                      border: `1px solid #BFDBFE`,
                      fontSize: fontSize.sm,
                      color: neutral[600],
                      lineHeight: 1.6,
                    }}
                  >
                    <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>▣</span>
                    <span>
                      MCP server 暴露的工具将注册为{" "}
                      <code
                        style={{
                          fontFamily: fontFamily.mono,
                          color: neutral[800],
                          backgroundColor: neutral[100],
                          padding: "1px 6px",
                          borderRadius: radius.sm,
                        }}
                      >
                        {"{server}_{tool}"}
                      </code>
                      ，进入 opencode 工具命名空间，经权限控制后由 Agent 调用。
                    </span>
                  </div>
                </>
              )}
            </div>
          </section>

          {/* ③ 输入 / 输出 Schema（统一区）：code / cli(schema) / http 共用同一「输入 JSON Schema」
              编辑器（模型靠它知道传什么参数，模型怎么调）；cli 自由调用显示自动生成的极简
              {command} schema（cli-free-schema，只读，与 opencode bash 工具同模式 —— 工具
              强制要求 input schema，自由调用=极简 {command} schema 而非无 schema）；
              mcp 例外——server 自带 schema 无需配置 */}
          <section
            data-testid="input-schema-section"
            data-exec-type={execType}
            style={{ display: "flex", flexDirection: "column", gap: space.md }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <StepNum n={3} />
              <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                输入 / 输出 Schema
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                模型怎么调：code / cli / http 统一声明；mcp 由 server 自带
              </span>
            </div>

            {/* 概念说明条：Schema = 模型调用接口声明 */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: space.sm,
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                backgroundColor: "#EFF6FF",
                border: `1px solid #BFDBFE`,
                fontSize: fontSize.sm,
                color: neutral[600],
                lineHeight: 1.6,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>◈</span>
              <span>
                定义<strong style={{ color: "#2563EB", fontWeight: 600 }}>模型调用该工具的输入参数</strong>
                （模型据此生成调用）—— 所有执行类型统一在此声明（除 MCP 外），与执行方式无关。
              </span>
            </div>

            {/* 3a. code / cli(schema) / http：共用输入/输出 JSON Schema 编辑器（切换类型不消失；
                cli 自由调用模式改用下方 3a-2 自动生成的极简 schema，见 cli-free-schema） */}
            {execType !== "mcp" && (execType !== "cli" || cliMode === "schema") && (
              <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                  <FieldRow label="输入 Schema（input）" hint="必填 · 模型调用时的入参声明">
                    <textarea
                      data-testid="input-schema-editor"
                      readOnly
                      rows={8}
                      spellCheck={false}
                      value={INPUT_SCHEMA_EXAMPLE}
                      style={{
                        ...inputStyle,
                        fontFamily: fontFamily.mono,
                        resize: "none",
                        lineHeight: 1.7,
                        backgroundColor: neutral[100],
                        cursor: "default",
                      }}
                    />
                  </FieldRow>
                  <FieldRow label="输出 Schema（output）" hint="可选 · 工具返回给模型的结构化结果">
                    <textarea
                      data-testid="output-schema-editor"
                      readOnly
                      rows={8}
                      spellCheck={false}
                      value={OUTPUT_SCHEMA_EXAMPLE}
                      style={{
                        ...inputStyle,
                        fontFamily: fontFamily.mono,
                        resize: "none",
                        lineHeight: 1.7,
                        backgroundColor: neutral[100],
                        cursor: "default",
                      }}
                    />
                  </FieldRow>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    fontSize: fontSize.xs,
                    color: neutral[400],
                  }}
                >
                  <span aria-hidden>◷</span>
                  {execType === "code"
                    ? "模型按输入 Schema 生成调用，代码 handler 按输出 Schema 返回结构化结果"
                    : execType === "cli"
                      ? "模型按输入 Schema 生成调用；参数如何拼进命令由下方「执行绑定」决定（模型无感知）"
                      : "模型按输入 Schema 生成调用；参数如何拼进请求由下方「执行绑定」决定（模型无感知）"}
                </div>
              </div>
            )}

            {/* 3a-2. CLI 自由调用：显示平台自动生成的极简 {command} schema（只读，与 opencode bash
                工具同模式 —— 工具强制要求 input schema（v2 Tool.make 的 input 必填），
                「自由调用」= 极简 command schema 而非无 schema） */}
            {execType === "cli" && cliMode === "free" && (
              <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
                <FieldRow label="输入 Schema（input · 自动生成）" hint="只读 · 平台自动生成极简 schema，无需手写">
                  <textarea
                    data-testid="cli-free-schema"
                    readOnly
                    rows={8}
                    spellCheck={false}
                    value={CLI_FREE_SCHEMA_EXAMPLE}
                    style={{
                      ...inputStyle,
                      fontFamily: fontFamily.mono,
                      resize: "none",
                      lineHeight: 1.7,
                      backgroundColor: neutral[100],
                      cursor: "default",
                    }}
                  />
                </FieldRow>
                {/* 说明：极简 {command} schema 与 opencode bash 工具同模式（符合工具协议） */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: space.sm,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.md,
                    backgroundColor: "#EFF6FF",
                    border: `1px solid #BFDBFE`,
                    fontSize: fontSize.sm,
                    color: neutral[600],
                    lineHeight: 1.6,
                  }}
                >
                  <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⌥</span>
                  <span>{CLI_FREE_NOTE}</span>
                </div>
              </div>
            )}

            {/* 3b. MCP：server 自带工具 schema，无需配置（保留 mcp-schema-note） */}
            {execType === "mcp" && (
              <div
                data-testid="mcp-schema-note"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: space.sm,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#EFF6FF",
                  border: `1px solid #BFDBFE`,
                  fontSize: fontSize.sm,
                  color: neutral[600],
                  lineHeight: 1.6,
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>▣</span>
                <span>
                  <strong style={{ color: "#2563EB", fontWeight: 600 }}>无需配置输入 Schema</strong>
                  —— 连接后由 MCP server 声明工具的输入输出；暴露的工具注册为{" "}
                  <code
                    style={{
                      fontFamily: fontFamily.mono,
                      color: neutral[800],
                      backgroundColor: neutral[100],
                      padding: "1px 6px",
                      borderRadius: radius.sm,
                    }}
                  >
                    {"{server}_{tool}"}
                  </code>
                  ，进入 opencode 工具命名空间后即可被模型调用。
                </span>
              </div>
            )}
          </section>

          {/* ④ 执行绑定（按类型动态）：仅 cli(schema) / http —— 参数如何拼入命令/请求（执行期细节，
              模型无感知）；code/mcp 无此步骤；cli 自由调用无参数映射（command 是整体字符串），整区隐藏 */}
          {!(execType === "cli" && cliMode === "free") && (
            <section
              data-testid="binding-section"
              data-exec-type={execType}
              style={{ display: "flex", flexDirection: "column", gap: space.md }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <StepNum n={4} />
                <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  执行绑定
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  cli / http 专属（可选）：参数如何拼入命令 / 请求
                </span>
              </div>

              {/* 概念说明条：执行绑定 = 执行期细节，模型无感知 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: space.sm,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: "#EFF6FF",
                  border: `1px solid #BFDBFE`,
                  fontSize: fontSize.sm,
                  color: neutral[600],
                  lineHeight: 1.6,
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⇄</span>
                <span>
                  模型按输入 Schema 传参；此处绑定<strong style={{ color: "#2563EB", fontWeight: 600 }}>参数如何拼入命令 / 请求</strong>
                  （执行期细节，模型无感知）。
                </span>
              </div>

              {/* 4a. CLI（Schema 化）：参数映射（参数名来自输入 Schema → {{占位符}}）+ 输出解析；
                  cli 自由调用模式无参数映射（整区在 free 时隐藏） */}
              {execType === "cli" && cliMode === "schema" && (
                <>
                  <FieldRow label="参数映射" hint="参数名（来自输入 Schema）→ 命令占位符">
                    <div
                      data-testid="binding-cli-list"
                      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
                    >
                      {cliArgMap.map((m) => (
                        <div
                          key={m.id}
                          data-testid="binding-cli-item"
                          data-arg={m.arg}
                          data-placeholder={m.placeholder}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: space.md,
                            padding: `${space.sm}px ${space.md}px`,
                            borderRadius: radius.md,
                            backgroundColor: neutral[100],
                            border: `1px solid ${neutral[200]}`,
                            fontFamily: fontFamily.mono,
                          }}
                        >
                          <code
                            style={{
                              width: 140,
                              flexShrink: 0,
                              fontSize: fontSize.sm,
                              fontWeight: 600,
                              color: neutral[800],
                            }}
                          >
                            {m.arg}
                          </code>
                          <span aria-hidden style={{ color: neutral[400] }}>→</span>
                          <code
                            style={{
                              fontSize: fontSize.sm,
                              fontWeight: 600,
                              color: "#2563EB",
                              backgroundColor: "#EFF6FF",
                              padding: "1px 6px",
                              borderRadius: radius.sm,
                            }}
                          >
                            {m.placeholder}
                          </code>
                          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.body }}>
                            {m.desc}
                          </span>
                        </div>
                      ))}
                    </div>
                  </FieldRow>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                    <FieldRow label="输出解析" hint="决定如何解析 stdout 为工具输出">
                      <select
                        data-testid="cli-output-parse"
                        value={cliOutput}
                        onChange={(e) => setCliOutput(e.target.value as "json" | "text")}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        <option value="json">JSON 解析（提取字段）</option>
                        <option value="text">纯文本（整段返回）</option>
                      </select>
                    </FieldRow>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.sm}px ${space.md}px`,
                        borderRadius: radius.md,
                        backgroundColor: neutral[100],
                        border: `1px solid ${neutral[200]}`,
                        fontSize: fontSize.xs,
                        color: neutral[400],
                        lineHeight: 1.5,
                      }}
                    >
                      <span aria-hidden>◷</span>
                      {cliOutput === "json"
                        ? "stdout 按 JSON.parse 解析，字段映射到工具输出 schema"
                        : "stdout 整段作为 text 返回，原样写入输出 schema"}
                    </div>
                  </div>
                </>
              )}

              {/* 4b. HTTP：参数位置映射（参数名来自输入 Schema + query/body/path 位置）+ 响应解析 */}
              {execType === "http" && (
                <>
                  <FieldRow label="参数位置映射" hint="参数名（来自输入 Schema）→ 请求位置 query / body / path">
                    <div
                      data-testid="binding-http-list"
                      style={{ display: "flex", flexDirection: "column", gap: space.sm }}
                    >
                      {httpParams.map((p) => (
                        <div
                          key={p.id}
                          data-testid="binding-http-item"
                          data-arg={p.arg}
                          data-location={httpLocs[p.arg]}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: space.md,
                            padding: `${space.sm}px ${space.md}px`,
                            borderRadius: radius.md,
                            backgroundColor: neutral[100],
                            border: `1px solid ${neutral[200]}`,
                            fontFamily: fontFamily.mono,
                          }}
                        >
                          <code
                            style={{
                              width: 140,
                              flexShrink: 0,
                              fontSize: fontSize.sm,
                              fontWeight: 600,
                              color: neutral[800],
                            }}
                          >
                            {p.arg}
                          </code>
                          <span aria-hidden style={{ color: neutral[400] }}>→</span>
                          <select
                            aria-label={`${p.arg} 请求位置`}
                            value={httpLocs[p.arg]}
                            onChange={(e) =>
                              setHttpLocs((prev) => ({
                                ...prev,
                                [p.arg]: e.target.value as "query" | "body" | "path",
                              }))
                            }
                            style={{
                              ...inputStyle,
                              width: 120,
                              padding: `${space.xs}px ${space.sm}px`,
                              fontSize: fontSize.sm,
                              fontFamily: fontFamily.mono,
                              cursor: "pointer",
                            }}
                          >
                            {HTTP_LOCATIONS.map((loc) => (
                              <option key={loc} value={loc}>
                                {loc}
                              </option>
                            ))}
                          </select>
                          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.body }}>
                            {p.desc}
                          </span>
                        </div>
                      ))}
                    </div>
                  </FieldRow>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                    <FieldRow label="响应解析" hint="决定如何解析响应为工具输出">
                      <select
                        data-testid="http-output-parse"
                        value={httpOutput}
                        onChange={(e) => setHttpOutput(e.target.value as "json" | "text")}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        <option value="json">JSON 解析（提取字段）</option>
                        <option value="text">纯文本（整段返回）</option>
                      </select>
                    </FieldRow>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.sm}px ${space.md}px`,
                        borderRadius: radius.md,
                        backgroundColor: neutral[100],
                        border: `1px solid ${neutral[200]}`,
                        fontSize: fontSize.xs,
                        color: neutral[400],
                        lineHeight: 1.5,
                      }}
                    >
                      <span aria-hidden>◷</span>
                      响应按 2xx / 非 2xx 映射成功与失败，body 按所选方式解析为工具输出
                    </div>
                  </div>
                </>
              )}

              {/* 4c. 平台代码：无执行绑定（execute 直接使用输入参数） */}
              {execType === "code" && (
                <div
                  data-testid="binding-code-note"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: space.sm,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[100],
                    border: `1px solid ${neutral[200]}`,
                    fontSize: fontSize.sm,
                    color: neutral[600],
                    lineHeight: 1.6,
                  }}
                >
                  <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⌘</span>
                  <span>
                    <strong style={{ color: neutral[800], fontWeight: 600 }}>无需执行绑定</strong>
                    —— execute 函数直接使用输入参数（handler 内引用 input），没有拼命令 / 拼请求的环节。
                  </span>
                </div>
              )}

              {/* 4d. MCP：无执行绑定（由 MCP server 处理） */}
              {execType === "mcp" && (
                <div
                  data-testid="binding-mcp-note"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: space.sm,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[100],
                    border: `1px solid ${neutral[200]}`,
                    fontSize: fontSize.sm,
                    color: neutral[600],
                    lineHeight: 1.6,
                  }}
                >
                  <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>▣</span>
                  <span>
                    <strong style={{ color: neutral[800], fontWeight: 600 }}>无需执行绑定</strong>
                    —— 参数如何传入由 MCP server 处理，平台不拼接命令 / 请求。
                  </span>
                </div>
              )}
            </section>
          )}

          {/* ⑤ 初始化命令 / 脚本（本页核心）：工具执行前由 worker 节点运行，完成环境准备 */}
          <section
            data-testid="init-section"
            style={{ display: "flex", flexDirection: "column", gap: space.md }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <StepNum n={5} />
              <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                初始化命令 / 脚本
              </span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                工具执行前，worker 节点先运行以下初始化命令/脚本来准备环境（如安装二进制、配置凭据）
              </span>
            </div>

            {/* 执行时机说明 */}
            <div
              data-testid="init-hint"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: space.sm,
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                backgroundColor: "#EFF6FF",
                border: `1px solid #BFDBFE`,
                fontSize: fontSize.sm,
                color: neutral[600],
                lineHeight: 1.6,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: 2 }}>⚙</span>
              <span>
                <strong style={{ color: "#2563EB", fontWeight: 600 }}>执行时机</strong>
                ：worker 节点在首次执行该工具前运行初始化命令；已初始化过的节点跳过
                （可配置强制重跑）。平台不自动推断二进制，命令由工具注册者自行填写。
              </span>
            </div>

            {/* 初始化命令列表 */}
            <div
              data-testid="init-command-list"
              style={{ display: "flex", flexDirection: "column", gap: space.sm }}
            >
              {initCommands.map((cmd, i) => (
                <InitCommandRow
                  key={cmd.id}
                  cmd={cmd}
                  index={i}
                  onScriptChange={(v) => updateInitScript(cmd.id, v)}
                  onNoteChange={(v) => updateInitNote(cmd.id, v)}
                  onRemove={() => removeInitCommand(cmd.id)}
                />
              ))}
            </div>

            {/* 添加初始化命令 */}
            <button
              type="button"
              data-testid="add-init-command"
              onClick={addInitCommand}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                border: `1px dashed ${neutral[300]}`,
                backgroundColor: neutral[50],
                color: neutral[600],
                fontSize: fontSize.sm,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.sm }}>＋</span>
              添加初始化命令
            </button>
          </section>
        </div>

        {/* 底部操作：注册工具 / 取消 + 提交反馈 */}
        <div
          data-testid="tool-register-footer"
          style={{ display: "flex", alignItems: "center", gap: space.md }}
        >
          <button
            type="button"
            data-testid="register-tool-button"
            onClick={handleRegister}
            disabled={registering}
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
              cursor: registering ? "default" : "pointer",
              opacity: registering ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden>✚</span>
            {registering ? "注册中…" : "注册工具"}
          </button>
          <button
            type="button"
            data-testid="register-cancel-button"
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
            <span aria-hidden style={{ fontSize: fontSize.sm }}>◷</span>
            manifest 注册后编译 v1 / v2 分发（07 篇 10.3）
          </span>
        </div>

        {/* 注册反馈（校验失败 / API 失败 / 注册成功 三态，POST /tools 真实提交） */}
        {registerState === "error" && (
          <div
            data-testid="register-feedback"
            data-state="error"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: space.sm,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: "#FEF2F2",
              border: `1px solid #FECACA`,
              color: "#DC2626",
              fontSize: fontSize.sm,
              lineHeight: 1.6,
              ...baseFont,
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>⚠️</span>
            <span>{registerError ?? "注册失败：工具名不能为空，请填写工具名（标识符）。"}</span>
          </div>
        )}
        {registerState === "success" && (
          <div
            data-testid="register-feedback"
            data-state="success"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: space.sm,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: "#ECFDF5",
              border: `1px solid #A7F3D0`,
              color: "#059669",
              fontSize: fontSize.sm,
              lineHeight: 1.6,
              ...baseFont,
            }}
          >
            <span aria-hidden style={{ fontSize: fontSize.lg, lineHeight: 1 }}>✓</span>
            <span>
              工具 <strong style={{ color: "#059669" }}>{toolName.trim() || "(未命名)"}</strong>{" "}
              注册成功，可在「技能/工具」页面查看。
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
