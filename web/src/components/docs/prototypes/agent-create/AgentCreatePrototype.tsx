import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconChevronLeft, IconChevronRight, IconClock, IconLock, StatusBadge } from "../_shared/ui";

/**
 * 新建 Agent 表单页原型（组：管理）
 * =====================================================
 * 模拟从 Agent 管理页点击"新建 Agent"进入的完整创建流程。
 * PC：左侧步骤条 + 右侧表单区；移动端：顶部横向小步骤 + 单列表单。
 * 纯 UI 原型：步骤切换 / 下拉 / 多选 / switch 为本地交互，无真实创建逻辑。
 */

type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

/** 内联图标（原型内自包含，stroke 风格与 _shared 一致） */
function Icon({ className = "size-4", children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconBot({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 4v4M8 4h8" />
      <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconServer({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="8" x="3" y="4" rx="2" />
      <rect width="18" height="8" x="3" y="12" rx="2" />
      <circle cx="7" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconWrench({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14.5 12l-2.5-2.5 2.7-3.2Z" />
    </Icon>
  );
}

function IconTerminal({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </Icon>
  );
}

function IconFolder({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  );
}

function IconExternalLink({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  );
}

function IconX({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

function IconSparkles({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5c.6 2.2 2.3 3.9 4.5 4.5-2.2.6-3.9 2.3-4.5 4.5-.6-2.2-2.3-3.9-4.5-4.5 2.2-.6 3.9-2.3 4.5-4.5Z" />
    </Icon>
  );
}

/** 纯 UI switch 开关 */
function Switch({
  checked,
  onChange,
  label,
  tone = "brand",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  tone?: Tone;
}) {
  const onClass = tone === "danger" ? "bg-danger-500" : "bg-brand-600";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? onClass : "bg-slate-200"
      }`}
    >
      <span
        className={`inline-block size-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** 表单字段共用样式 */
const inputCls =
  "w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

const labelCls = "mb-1.5 block text-xs font-medium text-slate-600";

/* ---------- 数据 ---------- */

const STEPS = [
  { key: "basic", title: "基本信息", desc: "名称、命名空间与运行时" },
  { key: "model", title: "模型配置", desc: "模型引用、预算与超时" },
  { key: "prompt", title: "提示词与技能", desc: "系统提示词与关联 Skills" },
  { key: "tools", title: "工具与权限", desc: "可用工具与权限控制" },
];

const NAMESPACES = ["default", "dev-team", "test-team", "system"];

const ROLES = ["产品经理", "架构师", "开发工程师", "测试工程师", "通用"];

const MODEL_ENDPOINTS = [
  { id: "openai-default", name: "OpenAI 默认端点", model: "gpt-5.2" },
  { id: "anthropic-claude", name: "Anthropic Claude 端点", model: "claude-sonnet-4" },
  { id: "deepseek", name: "DeepSeek 端点", model: "deepseek-v4-flash" },
  { id: "qwen-max", name: "通义千问端点", model: "qwen-max-2026" },
];

const FALLBACK_MODELS = [
  { id: "gpt-5.2", label: "gpt-5.2", tone: "brand" as Tone },
  { id: "claude-sonnet-4", label: "claude-sonnet-4", tone: "warning" as Tone },
  { id: "deepseek-v4-flash", label: "deepseek-v4-flash", tone: "info" as Tone },
  { id: "qwen-max-2026", label: "qwen-max-2026", tone: "neutral" as Tone },
];

/** opencode serve 运行时实例（与「全局设置 → 运行时」多实例管理呼应） */
const RUNTIME_INSTANCES = [
  {
    id: "opencode-dev",
    name: "opencode-dev",
    host: "127.0.0.1",
    port: 4096,
    connected: true,
    defaultWorkspace: "/workspaces/opencode-dev",
  },
  {
    id: "opencode-cicd",
    name: "opencode-cicd",
    host: "10.0.0.5",
    port: 4096,
    connected: true,
    defaultWorkspace: "/workspaces/opencode-cicd",
  },
  {
    id: "opencode-prod",
    name: "opencode-prod",
    host: "10.0.0.9",
    port: 4096,
    connected: false,
    defaultWorkspace: "/workspaces/opencode-prod",
  },
];

/** 浏览弹层中展示的常用路径（模拟，非真实文件系统） */
const COMMON_DIRS = [
  "/data/projects/repo-a",
  "/data/projects/repo-b",
  "/workspaces/opencode-dev",
  "/home/dev/app",
  "/tmp/sandbox",
];

const PROMPT_TEMPLATES = ["需求分析", "代码评审", "测试用例"];

const SKILLS = [
  { id: "req-doc", name: "需求文档生成", desc: "PRD / 需求拆解与验收标准" },
  { id: "test-case", name: "测试用例生成", desc: "边界条件与回归用例设计" },
  { id: "code-review", name: "代码评审标准", desc: "工程规范与反模式检查" },
  { id: "spl-search", name: "SPL 日志检索", desc: "日志查询与异常分析" },
  { id: "security-audit", name: "安全审计", desc: "敏感信息与风险扫描" },
];

const TOOLS = [
  { id: "github_create_pr", name: "github_create_pr", desc: "创建 / 更新 GitHub Pull Request", risk: "中" },
  { id: "jenkins_trigger_build", name: "jenkins_trigger_build", desc: "触发 Jenkins 流水线构建", risk: "高" },
  { id: "web_search", name: "web_search", desc: "联网检索公开信息", risk: "低" },
  { id: "git_commit", name: "git_commit", desc: "在任务工作区执行 Git 提交", risk: "中" },
  { id: "secret_read", name: "secret_read", desc: "读取已授权的凭证密钥", risk: "高" },
  { id: "sql_query", name: "sql_query", desc: "对授权数据源执行查询", risk: "高" },
];

function riskTone(risk: string): Tone {
  if (risk === "高") return "danger";
  if (risk === "中") return "warning";
  return "neutral";
}

/* ---------- 组件 ---------- */

export default function AgentCreatePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [step, setStep] = useState(0);

  // 步骤一：基本信息
  const [namespace, setNamespace] = useState("dev-team");
  const [role, setRole] = useState("产品经理");

  // 步骤一：运行时实例与工作目录
  const [runtimeId, setRuntimeId] = useState(RUNTIME_INSTANCES[0].id);
  const [workdir, setWorkdir] = useState(RUNTIME_INSTANCES[0].defaultWorkspace);
  const [dirPicker, setDirPicker] = useState(false);

  const runtime = RUNTIME_INSTANCES.find((i) => i.id === runtimeId)!;

  const changeRuntime = (id: string) => {
    setRuntimeId(id);
    const inst = RUNTIME_INSTANCES.find((i) => i.id === id)!;
    setWorkdir(inst.defaultWorkspace);
  };

  // 步骤二：模型配置
  const [endpoint, setEndpoint] = useState("openai-default");
  const [fallbacks, setFallbacks] = useState<string[]>(["claude-sonnet-4"]);
  const [tokenBudget, setTokenBudget] = useState("1000000");
  const [timeoutVal, setTimeoutVal] = useState("15");
  const [timeoutUnit, setTimeoutUnit] = useState("分钟");

  // 步骤三：提示词与技能
  const [prompt, setPrompt] = useState(
    "你是 Orchestra 平台的产品经理 Agent，负责需求分析与文档产出。你的目标是：\n1. 将业务诉求拆解为清晰、可验收的功能需求；\n2. 输出 PRD 文档并关联对应流程定义；\n3. 对模糊需求主动提问澄清，而不是擅自假设。"
  );
  const [skills, setSkills] = useState<string[]>(["req-doc", "test-case"]);

  // 步骤四：工具与权限
  const [toolPerms, setToolPerms] = useState<Record<string, boolean>>({
    github_create_pr: true,
    jenkins_trigger_build: false,
    web_search: true,
    git_commit: true,
    secret_read: false,
    sql_query: false,
  });
  const [approveHighRisk, setApproveHighRisk] = useState(true);

  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 返回链接 */}
      <a
        href="#agent-list"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 transition-colors hover:text-brand-600"
      >
        <IconChevronLeft className="size-4" />
        返回 Agent 管理
      </a>

      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">新建 Agent</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            分 {STEPS.length} 步配置智能体实例 · 创建后可在 Agent 管理中查看与编辑
          </p>
        </div>
        <StatusBadge tone="brand" dot={false}>
          草稿
        </StatusBadge>
      </div>

      <div className={mobile ? "" : "flex items-start gap-5"}>
        {/* 步骤条：PC 左侧竖排 / 移动端顶部横向 */}
        {mobile ? (
          <div className="mb-4 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">
                步骤 {step + 1}/{STEPS.length}
              </span>
              <span className="text-xs font-semibold text-slate-900">{current.title}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {STEPS.map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStep(i)}
                  aria-label={s.title}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    i <= step ? "bg-brand-600" : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          </div>
        ) : (
          <aside className="w-56 shrink-0">
            <ol className="rounded-[--radius-card] border border-slate-200 bg-white p-2 shadow-panel">
              {STEPS.map((s, i) => {
                const active = i === step;
                const done = i < step;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => setStep(i)}
                      className={`flex w-full items-start gap-3 rounded-[--radius-control] px-3 py-2.5 text-left transition-colors ${
                        active ? "bg-brand-50 ring-1 ring-inset ring-brand-500/25" : "hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                          active
                            ? "bg-brand-600 text-white"
                            : done
                              ? "bg-success-500 text-white"
                              : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block text-sm font-medium ${
                            active ? "text-brand-700" : "text-slate-700"
                          }`}
                        >
                          {s.title}
                        </span>
                        <span className="block text-[11px] text-slate-400">{s.desc}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 rounded-[--radius-control] bg-info-50 px-3 py-2 text-[11px] leading-relaxed text-info-700">
              带 <span className="font-medium">*</span> 为必填项；步骤可在提交前自由切换，数据保留在当前会话。
            </div>
          </aside>
        )}

        {/* 右侧表单区 */}
        <main className="min-w-0 flex-1">
          <section className="rounded-[--radius-card] border border-slate-200 bg-white p-5 shadow-panel">
            <header className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
              {step === 0 && <IconBot className="size-4 text-brand-600" />}
              {step === 1 && <IconServer className="size-4 text-brand-600" />}
              {step === 2 && <IconSparkles className="size-4 text-brand-600" />}
              {step === 3 && <IconWrench className="size-4 text-brand-600" />}
              <h2 className="text-sm font-semibold text-slate-900">
                步骤 {step + 1} · {current.title}
              </h2>
              <span className="ml-auto text-xs text-slate-400">{current.desc}</span>
            </header>

            {/* ---- 步骤一 基本信息 ---- */}
            {step === 0 && (
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>
                    Agent 名称 <span className="text-danger-500">*</span>
                  </label>
                  <input type="text" placeholder="如 需求分析助手" className={inputCls} />
                  <p className="mt-1 text-[11px] text-slate-400">建议 2~20 个字符，创建后可作为流程节点引用</p>
                </div>
                <div>
                  <label className={labelCls}>描述</label>
                  <textarea
                    rows={2}
                    placeholder="这个 Agent 负责什么？适合哪些流程场景…"
                    className={inputCls}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>
                      所属命名空间 <span className="text-danger-500">*</span>
                    </label>
                    <select
                      value={namespace}
                      onChange={(e) => setNamespace(e.target.value)}
                      className={inputCls}
                    >
                      {NAMESPACES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                          {n === "default" ? "（默认）" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>角色（可选）</label>
                    <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="rounded-[--radius-control] bg-slate-50 p-3 ring-1 ring-slate-100">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-slate-600">
                      运行时 <span className="font-normal text-slate-400">（类型：opencode）</span>
                    </label>
                    <a
                      href="#runtime-manage"
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
                    >
                      管理实例
                      <IconExternalLink className="size-3" />
                    </a>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <IconTerminal className="size-4 text-slate-400" />
                    <span className="font-mono text-sm text-slate-700">opencode</span>
                    <StatusBadge tone="brand" dot={false}>
                      唯一类型
                    </StatusBadge>
                  </div>

                  <div className="mt-3">
                    <label className={labelCls}>
                      运行实例 <span className="text-danger-500">*</span>
                    </label>
                    <select
                      value={runtimeId}
                      onChange={(e) => changeRuntime(e.target.value)}
                      className={inputCls}
                    >
                      {RUNTIME_INSTANCES.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}（{i.host}:{i.port}）{i.connected ? " · 已连接" : " · 未连接"}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-400">
                      选择执行该 Agent 的 opencode serve 实例，实例列表可在「全局设置 → 运行时」维护。
                    </p>
                  </div>

                  <div className="mt-2 rounded-[--radius-control] bg-white px-3 py-2.5 ring-1 ring-slate-200">
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium text-slate-700">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            runtime.connected ? "bg-success-500" : "bg-danger-500"
                          }`}
                        />
                        <span className="truncate">{runtime.name}</span>
                      </p>
                      <StatusBadge tone={runtime.connected ? "success" : "danger"}>
                        {runtime.connected ? "已连接" : "未连接"}
                      </StatusBadge>
                    </div>
                    <dl className="mt-2 space-y-1 text-[11px]">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-slate-400">地址</dt>
                        <dd className="truncate font-mono text-slate-600">
                          http://{runtime.host}:{runtime.port}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="shrink-0 text-slate-400">默认工作区</dt>
                        <dd className="truncate font-mono text-slate-600">{runtime.defaultWorkspace}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="mt-3">
                    <label className={labelCls}>工作目录</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={workdir}
                        onChange={(e) => setWorkdir(e.target.value)}
                        placeholder="/workspaces/<repo> 或 /data/projects/repo-a"
                        className={`${inputCls} min-w-0 flex-1 font-mono`}
                      />
                      <Button variant="outline" className="shrink-0" onClick={() => setDirPicker(true)}>
                        <IconFolder className="size-3.5" />
                        浏览
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      运行该 Agent 时的工作目录，通常是仓库路径；留空使用实例默认工作区（
                      {runtime.defaultWorkspace}）。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ---- 步骤二 模型配置 ---- */}
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>
                    模型引用 <span className="text-danger-500">*</span>
                  </label>
                  <select
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    className={inputCls}
                  >
                    {MODEL_ENDPOINTS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}（{m.model}）
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-400">
                    引用「全局设置 → 模型端点」中配置的端点，Token 密钥由凭证管理统一注入。
                  </p>
                </div>
                <div>
                  <label className={labelCls}>备用模型（多选，主模型不可用时自动降级）</label>
                  <div className="flex flex-wrap gap-2">
                    {FALLBACK_MODELS.map((m) => {
                      const on = fallbacks.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setFallbacks(toggle(fallbacks, m.id))}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                            on
                              ? "border-brand-400 bg-brand-50 text-brand-700"
                              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              m.tone === "brand"
                                ? "bg-brand-500"
                                : m.tone === "warning"
                                  ? "bg-warning-500"
                                  : m.tone === "info"
                                    ? "bg-info-500"
                                    : "bg-slate-400"
                            }`}
                          />
                          <span className="font-mono">{m.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>Token 预算（每次任务上限）</label>
                    <div className="relative">
                      <input
                        type="number"
                        value={tokenBudget}
                        onChange={(e) => setTokenBudget(e.target.value)}
                        className={inputCls}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                        tokens
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">超限任务自动暂停并通知审批人</p>
                  </div>
                  <div>
                    <label className={labelCls}>任务超时</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={timeoutVal}
                        onChange={(e) => setTimeoutVal(e.target.value)}
                        className={inputCls}
                      />
                      <select
                        value={timeoutUnit}
                        onChange={(e) => setTimeoutUnit(e.target.value)}
                        className="w-28 shrink-0 rounded-[--radius-control] border border-slate-200 bg-white px-2 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                      >
                        <option value="秒">秒</option>
                        <option value="分钟">分钟</option>
                        <option value="小时">小时</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ---- 步骤三 提示词与技能 ---- */}
            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-600">系统提示词</label>
                    <span className="text-[11px] text-slate-400">已输入 {prompt.length} 字符</span>
                  </div>
                  <textarea
                    rows={6}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className={`${inputCls} font-mono text-xs leading-relaxed`}
                  />
                </div>
                <div>
                  <label className={labelCls}>从模板插入</label>
                  <div className="flex flex-wrap gap-2">
                    {PROMPT_TEMPLATES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"
                      >
                        <IconSparkles className="size-3" />
                        {t}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    点击将对应提示词模板追加到文本末尾，可在「Skills 管理」中维护模板内容。
                  </p>
                </div>
                <div>
                  <label className={labelCls}>关联 Skills（多选）</label>
                  <div className="space-y-2">
                    {SKILLS.map((s) => {
                      const on = skills.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-[--radius-control] border px-3 py-2.5 transition-colors ${
                            on
                              ? "border-brand-300 bg-brand-50/60"
                              : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setSkills(toggle(skills, s.id))}
                            className="mt-0.5 size-4 rounded border-slate-300 accent-brand-600"
                          />
                          <span className="min-w-0">
                            <span className={`block text-sm font-medium ${on ? "text-brand-700" : "text-slate-700"}`}>
                              {s.name}
                            </span>
                            <span className="block text-[11px] text-slate-400">{s.desc}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ---- 步骤四 工具与权限 ---- */}
            {step === 3 && (
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>工具权限（允许 Agent 调用的工具）</label>
                  <div className="overflow-hidden rounded-[--radius-control] border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                          <th className="px-3 py-2 font-medium">工具</th>
                          <th className="hidden px-3 py-2 font-medium sm:table-cell">说明</th>
                          <th className="px-3 py-2 font-medium">风险</th>
                          <th className="px-3 py-2 text-right font-medium">允许</th>
                        </tr>
                      </thead>
                      <tbody>
                        {TOOLS.map((t) => (
                          <tr key={t.id} className="border-b border-slate-100 last:border-0">
                            <td className="px-3 py-2.5">
                              <span className="flex items-center gap-2">
                                <IconWrench className="size-3.5 shrink-0 text-slate-400" />
                                <span className="font-mono text-xs text-slate-700">{t.name}</span>
                              </span>
                            </td>
                            <td className="hidden px-3 py-2.5 text-xs text-slate-500 sm:table-cell">
                              {t.desc}
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusBadge tone={riskTone(t.risk)} dot={false}>
                                {t.risk}
                              </StatusBadge>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex justify-end">
                                <Switch
                                  checked={toolPerms[t.id] ?? false}
                                  onChange={(v) => setToolPerms({ ...toolPerms, [t.id]: v })}
                                  label={`允许 ${t.name}`}
                                  tone={riskTone(t.risk)}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    工具列表来自「插件市场」已安装插件，此处仅控制单个 Agent 的调用范围。
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
                  <div className="flex items-center gap-2">
                    <IconLock className="size-4 text-warning-500" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">高风险工具需审批</p>
                      <p className="text-[11px] text-slate-400">
                        调用高 / 中风险工具前生成审批任务，通过后方可执行
                      </p>
                    </div>
                  </div>
                  <Switch checked={approveHighRisk} onChange={setApproveHighRisk} label="高风险工具需审批" />
                </div>
              </div>
            )}
          </section>

          {/* 底部导航 */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={step === 0}
              onClick={() => setStep(Math.max(0, step - 1))}
            >
              <IconChevronLeft className="size-4" />
              上一步
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost">取消</Button>
              {isLast ? (
                <Button>
                  <IconBot className="size-4" />
                  创建 Agent
                </Button>
              ) : (
                <Button onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))}>
                  下一步
                  <IconChevronRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
          {!isLast && (
            <p className="mt-2 flex items-center gap-1 text-right text-[11px] text-slate-400">
              <IconClock className="size-3" />
              当前步骤 {step + 1} / {STEPS.length}，可随时返回修改
            </p>
          )}
        </main>
      </div>

      {/* 工作目录浏览弹层（模拟，非真实文件系统） */}
      {dirPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDirPicker(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-[--radius-card] bg-white shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <IconFolder className="size-4 text-brand-600" />
              <h3 className="text-sm font-semibold text-slate-900">选择工作目录</h3>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setDirPicker(false)}
                className="ml-auto rounded-[--radius-control] p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <IconX className="size-4" />
              </button>
            </header>
            <div className="p-3">
              <p className="mb-2 px-1 text-[11px] text-slate-400">常用路径（模拟，非真实文件系统）</p>
              <ul className="space-y-1">
                {[
                  runtime.defaultWorkspace,
                  ...COMMON_DIRS.filter((p) => p !== runtime.defaultWorkspace),
                ].map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkdir(p);
                        setDirPicker(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-[--radius-control] px-2.5 py-2 text-left font-mono text-xs transition-colors ${
                        p === workdir
                          ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-500/25"
                          : "text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <IconFolder className="size-3.5 shrink-0 text-slate-400" />
                      <span className="min-w-0 truncate">{p}</span>
                      {p === runtime.defaultWorkspace && (
                        <span className="ml-auto shrink-0 text-[10px] text-slate-400">实例默认</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button variant="ghost" onClick={() => setDirPicker(false)}>
                取消
              </Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
