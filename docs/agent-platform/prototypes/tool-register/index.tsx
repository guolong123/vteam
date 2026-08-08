/**
 * 原型：注册工具（含输入 Schema 统一区 + 执行绑定分离 · 07 篇 skill/tool 协议 + Worker 环境准备）
 * =============================================
 * 工具注册页：平台侧登记工具 manifest（name / description / version / role-bindings /
 * 输入输出 Schema —— Schema 统一声明「模型怎么调」，参数映射独立为「执行绑定」——
 * 以及工具执行前的「初始化命令/脚本」。
 *
 * 核心概念模型（用户澄清）：
 *   ① 输入 Schema：code / cli / http 统一 —— 模型靠它知道传什么参数（模型怎么调）；
 *      mcp 例外：server 自带 schema，无需配置。
 *   ② 执行绑定：仅 cli / http（可选）—— 把输入参数拼进 CLI 命令占位符 / HTTP 请求位置，
 *      是执行期细节，模型无感知；code / mcp 无此步骤。
 * 与 07 篇呼应：工具运行在 worker 节点内部（11.6 Worker 节点三组件）；
 * 平台不自动推断二进制依赖，由工具注册者自行填写初始化命令/脚本
 * （如安装 jcli、配置凭据），worker 节点在首次执行该工具前先运行这些命令完成环境准备。
 *
 * 页面内容（区块顺序）：
 * - ① 基础信息：工具名 / 描述 / 版本 / 绑定角色（多选 AgentBadge）。
 * - ② 执行方式区（execution-section）：定义工具被调用后如何执行 —— schema 是接口声明
 *   （模型知道怎么调），执行方式是实际干活的部分（真正执行逻辑）。四种执行形态受控切换
 *   （仿 install-method-tab 联动）：平台代码（handler-code-editor）/ CLI 封装
 *   （cli-command-template）/ HTTP 回调（回调 URL + 方法 + 认证）/ MCP 接入
 *   （mcp-type-select Local/Remote 受控切换：Local=mcp-command-input + cwd + 环境变量；
 *   Remote=mcp-url-input + headers + OAuth）。MCP 语义：工具通过连接 MCP server 获取
 *   （本地进程 / 远程服务），暴露的工具注册为 <server>_<tool> 进入 opencode 工具命名空间。
 *   CLI 封装含两个互斥子模式（cli-mode-select）：Schema 化调用（cli-mode-schema 默认，
 *   定义输入 Schema + 参数映射 + 输出解析，类型安全）/ 自由调用（cli-mode-free：
 *   平台自动生成极简 {command} schema —— 与 opencode bash 工具同模式（符合工具协议），
 *   模型像 bash 一样自由传命令字符串；配置区 cli-free-config：命令前缀 cli-free-command +
 *   白名单 cli-free-whitelist + 执行超时 cli-free-timeout + 工作目录）。
 *   CLI 类型联动初始化区：初始化命令未配置时提示「请配置初始化命令以准备 jcli 等环境」。
 * - ③ 输入 / 输出 Schema 区（input-schema-section，统一展示）：code / cli(schema) / http 共用
 *   同一个「输入 JSON Schema」编辑器（input-schema-editor，模型据此生成调用）+ 可选
 *   「输出 Schema」编辑器（output-schema-editor）；cli 自由调用显示自动生成的极简
 *   {command} schema（cli-free-schema，只读，与 opencode bash 工具同模式）；mcp 显示
 *   无需配置说明（mcp-schema-note：server 自带 schema）。
 *   说明文案：「定义模型调用该工具的输入参数（模型据此生成调用）」。
 * - ④ 执行绑定区（binding-section，按类型动态展示）：cli(schema)=参数映射列表（binding-cli-item：
 *   参数名 → {{占位符}}）+ 输出解析（cli-output-parse）；http=参数位置映射列表
 *   （binding-http-item：参数名 + query/body/path 位置）+ 响应解析（http-output-parse）；
 *   code=说明（binding-code-note：execute 直接使用输入参数）；mcp=说明（binding-mcp-note：
 *   由 MCP server 处理）；cli 自由调用无参数映射（command 是整体字符串），整区隐藏。
 * - ⑤ 初始化命令/脚本区（init-section，本页核心）：初始化命令列表（init-command-item）——
 *   每条含命令/脚本内容（init-command-input，textarea 多行 shell 脚本）+ 说明（可选，
 *   init-command-note），可添加（add-init-command）/ 删除（remove-init-command）；
 *   执行时机：worker 节点在首次执行该工具前运行初始化命令，已初始化过的节点跳过
 *   （可配置强制重跑）。
 * - 底部：注册工具（register-tool-button）+ 取消。纯静态展示（不实现真实命令执行）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/components
 *   （AgentBadge）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，零 fixed/vh/vw；
 *   T20：CmdKPanel 受控开关默认关闭；T21：Schema/命令/参数映射一律浅色
 *   （neutral[100] 底 + neutral[800] 字，勿黑底）。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import { AgentBadge } from "../_shared/components";
import type { RoleKey } from "../_shared/styles";
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

/* Cmd+K 命令项：导航组图标与 Dock 一一对应，「技能与工具」高亮呼应当前页 */
const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫", active: true },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "操作", label: "注册工具", icon: "✚" },
  { group: "操作", label: "配置初始化命令", icon: "▦" },
];

/* ------------------------------ mock 数据 ------------------------------ */

/** 初始化命令/脚本：工具执行前由 worker 节点运行，完成环境准备（如安装二进制、配置凭据）。
 * 平台不自动推断二进制依赖，命令内容由工具注册者自行填写。
 */
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
 * 用户决策：① 去掉「内置模板」执行类型 ② 平台不自动推断二进制依赖，改为工具注册者
 * 填写初始化命令/脚本，工具执行时先运行完成初始化。
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

/* ------------------------------ Schema / 执行绑定 mock ------------------------------
 * 核心概念模型（用户澄清）：
 *   输入 Schema：code / cli / http 统一声明「模型怎么调」—— 模型靠它知道传什么参数；
 *   mcp 例外：server 自带 schema 无需配置。
 *   执行绑定：仅 cli / http（可选）—— 参数如何拼入命令占位符 / 请求位置（执行期细节，
 *   模型无感知）；code / mcp 无此步骤。纯展示 mock，不实现真实 schema 校验。
 */

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

/* ------------------------------ 子组件 ------------------------------ */

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

function ToolRegisterPage() {
  /* Cmd+K 命令面板受控开关（T20）：默认关闭 */
  const [cmdkOpen, setCmdkOpen] = useState(false);

  /* 基础信息（受控，动态联动输入） */
  const [toolName, setToolName] = useState("jira-query");
  const [toolDesc, setToolDesc] = useState("按关键词查询 Jira 工单并返回结构化结果");
  const [version, setVersion] = useState("v1.4.0");

  /* 绑定角色（静态勾选态：产品/开发/测试选中，架构师未选） */
  const boundRoles: RoleKey[] = ["product", "developer", "tester"];
  const allRoles: RoleKey[] = ["product", "architect", "developer", "tester"];

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
   * 模型像 bash 一样自由传命令字符串。
   */
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
    "npx -y @modelcontextprotocol/server-filesystem /data"
  );
  const [mcpCwd, setMcpCwd] = useState("/data");
  const [mcpEnv, setMcpEnv] = useState("DATA_ROOT=/data\nLOG_LEVEL=info");
  const [mcpUrl, setMcpUrl] = useState("https://mcp.example.com/jira");
  const [mcpHeaders, setMcpHeaders] = useState(
    "Authorization: Bearer {{token}}\nContent-Type: application/json"
  );
  const [mcpOauth, setMcpOauth] = useState(false);

  return (
    <div
      data-testid="tool-register-root"
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
      {/* 浅色顶栏（面包屑模式：技能与工具 › 注册工具） */}
      <NavTopBar
        breadcrumb={["技能与工具", "注册工具"]}
        userName="运营者"
        userRole="平台管理员"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：居中表单卡片，左侧留白避让 Dock */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.xl}px ${space.xl}px ${space.xxl}px ${RAIL_W + space.xl}px`,
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

              {/* 绑定角色：多选 AgentBadge（静态勾选态） */}
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
                          ...baseFont,
                        }}
                      >
                        <span aria-hidden style={{ fontSize: fontSize.xs }}>
                          {bound ? "✓" : "○"}
                        </span>
                        {r === "product" ? "产品经理" : r === "architect" ? "架构师" : r === "developer" ? "开发者" : "测试"}
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
                {execTypes.map((t) => {
                  const active = execType === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      data-testid="execution-type"
                      data-exec-type={t.key}
                      data-active={active ? "true" : "false"}
                      onClick={() => setExecType(t.key)}
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
                        {t.icon}
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
                          {t.label}
                        </span>
                        <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                          {t.desc}
                        </span>
                      </span>
                    </button>
                  );
                })}
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
                        ).map((t) => {
                          const active = cliMode === t.key;
                          return (
                            <button
                              key={t.key}
                              type="button"
                              data-testid={t.key === "schema" ? "cli-mode-schema" : "cli-mode-free"}
                              data-active={active ? "true" : "false"}
                              onClick={() => setCliMode(t.key)}
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
                                {t.icon}
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
                                  {t.label}
                                </span>
                                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                                  {t.desc}
                                </span>
                              </span>
                            </button>
                          );
                        })}
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
                          <span>
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
                            schema（与{" "}
                            <strong style={{ color: "#2563EB", fontWeight: 600 }}>opencode bash 工具</strong>
                            同模式），模型像 bash 一样自由传命令字符串；适合通用 CLI 探索与快速接入。
                          </span>
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
                        ).map((t) => {
                          const active = mcpType === t.key;
                          return (
                            <button
                              key={t.key}
                              type="button"
                              data-testid="mcp-type-option"
                              data-type={t.key}
                              data-active={active ? "true" : "false"}
                              onClick={() => setMcpType(t.key)}
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
                                {t.icon}
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
                                  {t.label}
                                </span>
                                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
                                  {t.desc}
                                </span>
                              </span>
                            </button>
                          );
                        })}
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
                    <span>
                      使用极简{" "}
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
                      schema —— 与{" "}
                      <strong style={{ color: "#2563EB", fontWeight: 600 }}>opencode bash 工具</strong>
                      同模式，模型像 bash 一样自由传命令字符串（符合 opencode 工具协议）。
                    </span>
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

          {/* 底部操作：注册工具 / 取消 */}
          <div
            data-testid="tool-register-footer"
            style={{ display: "flex", alignItems: "center", gap: space.md }}
          >
            <button
              type="button"
              data-testid="register-tool-button"
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
              <span aria-hidden>✚</span>
              注册工具
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
        </div>
      </main>

      {/* 左侧 Dock 悬浮导航：工具属 Agent 配置域 */}
      <NavDock activeKey="skills" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（T20）——初始关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "tool-register",
    name: "注册工具",
    group: "平台",
    description:
      "工具注册表单：① 基础信息（名称/描述/版本/角色绑定）+ ② 执行方式区（4 种执行形态：平台代码/CLI 封装/HTTP 回调/MCP 接入，MCP 支持 Local 与 Remote 配置；CLI 封装含 Schema 化调用 cli-mode-schema（定义 Schema + 参数映射，默认）与自由调用 cli-mode-free（平台自动生成极简 {command} schema —— 同 opencode bash 工具模式，符合工具协议；配置：命令前缀 cli-free-command + 白名单 cli-free-whitelist + 超时 cli-free-timeout + 工作目录，模型像 bash 一样自由传命令字符串）两个互斥子模式 cli-mode-select）+ ③ 输入/输出 Schema 统一区（input-schema-section：code/cli(schema)/http 共用同一输入 JSON Schema 编辑器「模型怎么调」，可选输出 Schema 编辑器；cli 自由调用显示自动生成的极简 {command} schema（cli-free-schema，只读）；mcp 显示 server 自带 schema 无需配置的说明）+ ④ 执行绑定区（binding-section 按类型动态：cli(schema)=参数映射列表 binding-cli-item + 输出解析 cli-output-parse / http=参数位置映射 binding-http-item（query/body/path）+ 响应解析 http-output-parse / code=无需执行绑定说明 / mcp=由 server 处理说明；cli 自由调用无参数映射（command 是整体字符串）整区隐藏）+ ⑤ 初始化命令/脚本区（init-command-item 列表：多行脚本 + 说明 + 添加/删除，执行时机=worker 首次执行工具前运行、已初始化节点跳过），CLI 未配置初始化命令时提示「请配置初始化命令以准备 jcli 等环境」，平台不自动推断二进制依赖",
    device: "desktop",
  },
  Component: ToolRegisterPage,
};

export default def;
