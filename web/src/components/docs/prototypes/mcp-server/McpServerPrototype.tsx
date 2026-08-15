import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconPlus, IconRefresh, IconSearch, StatusBadge, type Tone } from "../_shared/ui";

/**
 * MCP 服务管理页原型（组：生态）
 * =====================================================
 * 模拟"MCP 服务注册与工具发现"管理界面：
 * 顶部标题 + 统计条（总服务 / 已连接 / 已发现工具），
 * PC 表格 / 移动端卡片列出已注册 MCP Server，
 * 行展开查看自动发现的工具清单（含风险标注），
 * "新建 MCP 服务"弹窗（本地 stdio / 远程 HTTP 表单）。
 * 纯 UI 原型：搜索 / 展开 / 新建弹窗 / 测试连接 loading 为本地交互。
 */

/* ---------- 自包含图标（stroke 风格，与 _shared/ui.tsx 一致） ---------- */

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

const IconServer = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="20" height="8" x="2" y="2" rx="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" />
    <path d="M6 6h.01M6 18h.01" />
  </Icon>
);

const IconPlug = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 22v-5" />
    <path d="M9 8V2M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </Icon>
);

const IconWrench = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Icon>
);

const IconChevronDown = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const IconKey = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m11 12 9-9M16 7l2 2M18 5l2 2" />
  </Icon>
);

/* ---------- 数据 ---------- */

type McpType = "stdio" | "http";
type McpStatus = "connected" | "disconnected" | "starting";
type AuthMethod = "none" | "bearer" | "oauth";
type ToolRisk = "normal" | "high";

interface McpTool {
  name: string;
  desc: string;
  params: string;
  risk: ToolRisk;
}

interface McpServer {
  id: string;
  name: string;
  type: McpType;
  endpoint: string;
  status: McpStatus;
  tools: McpTool[];
  auth: AuthMethod;
  updated: string;
}

const SERVERS: McpServer[] = [
  {
    id: "mcp-github",
    name: "github-mcp",
    type: "http",
    endpoint: "https://mcp.github.com/mcp",
    status: "connected",
    auth: "bearer",
    updated: "2026-07-30",
    tools: [
      { name: "github_create_pr", desc: "创建 Pull Request", params: "owner, repo, title, head, base", risk: "high" },
      { name: "github_list_issues", desc: "列出仓库 Issue", params: "owner, repo, state", risk: "normal" },
      { name: "github_get_repo", desc: "获取仓库信息", params: "owner, repo", risk: "normal" },
      { name: "github_create_issue", desc: "创建 Issue", params: "owner, repo, title, body", risk: "normal" },
      { name: "github_comment_issue", desc: "评论 Issue", params: "owner, repo, issue_number, body", risk: "normal" },
      { name: "github_merge_pr", desc: "合并 Pull Request", params: "owner, repo, pull_number, method", risk: "normal" },
      { name: "github_list_pull_requests", desc: "列出 Pull Request", params: "owner, repo, state", risk: "normal" },
      { name: "github_get_commit", desc: "获取提交详情", params: "owner, repo, ref", risk: "normal" },
      { name: "github_list_repos", desc: "列出仓库", params: "per_page, sort", risk: "normal" },
      { name: "github_search_code", desc: "搜索代码", params: "q, language", risk: "normal" },
      { name: "github_get_user", desc: "获取用户信息", params: "username", risk: "normal" },
      { name: "github_list_workflows", desc: "列出 Actions 工作流", params: "owner, repo", risk: "normal" },
    ],
  },
  {
    id: "mcp-context7",
    name: "context7-docs",
    type: "http",
    endpoint: "https://mcp.context7.com/mcp",
    status: "connected",
    auth: "none",
    updated: "2026-07-28",
    tools: [
      { name: "resolve_library_id", desc: "解析第三方库 ID", params: "query, library_name", risk: "normal" },
      { name: "query_docs", desc: "查询库文档", params: "library_id, query", risk: "normal" },
      { name: "list_libraries", desc: "列出可用库", params: "search", risk: "normal" },
      { name: "get_library_versions", desc: "获取库版本列表", params: "library_id", risk: "normal" },
      { name: "search_code_examples", desc: "搜索真实代码示例", params: "query, language", risk: "normal" },
      { name: "get_documentation", desc: "获取文档正文", params: "library_id, topic", risk: "normal" },
      { name: "compare_versions", desc: "对比版本差异", params: "library_id, from, to", risk: "normal" },
      { name: "get_recent_changes", desc: "获取近期更新", params: "library_id", risk: "normal" },
    ],
  },
  {
    id: "mcp-jenkins",
    name: "jenkins-mcp",
    type: "stdio",
    endpoint: "npx -y jenkins-mcp-server",
    status: "connected",
    auth: "bearer",
    updated: "2026-07-26",
    tools: [
      { name: "trigger_build", desc: "触发 Jenkins 构建", params: "job_name, parameters", risk: "high" },
      { name: "get_build_status", desc: "查询构建状态", params: "job_name, build_number", risk: "normal" },
      { name: "list_jobs", desc: "列出 Jenkins 任务", params: "folder", risk: "normal" },
      { name: "get_build_console", desc: "获取构建控制台日志", params: "job_name, build_number", risk: "normal" },
      { name: "get_build_artifacts", desc: "获取构建产物", params: "job_name, build_number", risk: "normal" },
      { name: "create_job", desc: "创建 Jenkins 任务", params: "name, config_xml", risk: "normal" },
    ],
  },
  {
    id: "mcp-gitee",
    name: "gitee-mcp",
    type: "http",
    endpoint: "https://mcp.gitee.com/mcp",
    status: "disconnected",
    auth: "bearer",
    updated: "2026-07-20",
    tools: [
      { name: "gitee_create_pr", desc: "创建 Pull Request", params: "owner, repo, title, head, base", risk: "normal" },
      { name: "gitee_list_issues", desc: "列出仓库 Issue", params: "owner, repo, state", risk: "normal" },
      { name: "gitee_get_repo", desc: "获取仓库信息", params: "owner, repo", risk: "normal" },
      { name: "gitee_create_issue", desc: "创建 Issue", params: "owner, repo, title, body", risk: "normal" },
      { name: "gitee_comment_issue", desc: "评论 Issue", params: "owner, repo, issue_number, body", risk: "normal" },
      { name: "gitee_merge_pr", desc: "合并 Pull Request", params: "owner, repo, pull_number", risk: "normal" },
      { name: "gitee_list_branches", desc: "列出分支", params: "owner, repo", risk: "normal" },
      { name: "gitee_get_commit", desc: "获取提交详情", params: "owner, repo, sha", risk: "normal" },
      { name: "gitee_search_repos", desc: "搜索仓库", params: "q, page", risk: "normal" },
    ],
  },
  {
    id: "mcp-internal-db",
    name: "internal-db-mcp",
    type: "stdio",
    endpoint: "npx -y @internal/db-mcp-server",
    status: "starting",
    auth: "none",
    updated: "2026-07-18",
    tools: [
      { name: "query_database", desc: "执行 SQL 查询", params: "sql, database", risk: "normal" },
      { name: "list_tables", desc: "列出数据库表", params: "database", risk: "normal" },
      { name: "get_table_schema", desc: "获取表结构", params: "database, table", risk: "normal" },
      { name: "check_connection", desc: "测试数据库连接", params: "database", risk: "normal" },
      { name: "estimate_query_cost", desc: "估算查询开销", params: "sql", risk: "normal" },
    ],
  },
  {
    id: "mcp-sentry",
    name: "sentry-mcp",
    type: "http",
    endpoint: "https://mcp.sentry.io/mcp",
    status: "connected",
    auth: "oauth",
    updated: "2026-07-15",
    tools: [
      { name: "list_issues", desc: "列出错误事件", params: "project, query", risk: "normal" },
      { name: "get_issue_detail", desc: "获取错误详情", params: "issue_id", risk: "normal" },
      { name: "create_alert_rule", desc: "创建告警规则", params: "project, name, conditions", risk: "normal" },
      { name: "get_project_stats", desc: "获取项目统计", params: "project, period", risk: "normal" },
    ],
  },
];

const TYPE_META: Record<McpType, { label: string; tone: Tone }> = {
  stdio: { label: "本地 stdio", tone: "info" },
  http: { label: "远程 HTTP", tone: "brand" },
};

const STATUS_META: Record<McpStatus, { label: string; tone: Tone }> = {
  connected: { label: "已连接", tone: "success" },
  disconnected: { label: "未连接", tone: "danger" },
  starting: { label: "启动中", tone: "warning" },
};

const AUTH_META: Record<AuthMethod, string> = {
  none: "无",
  bearer: "Bearer",
  oauth: "OAuth",
};

const totalTools = SERVERS.reduce((acc, s) => acc + s.tools.length, 0);
const connectedCount = SERVERS.filter((s) => s.status === "connected").length;

const STATS = [
  { label: "总服务数", value: String(SERVERS.length), accent: "bg-brand-500", icon: <IconServer className="size-4" />, trend: "覆盖代码 / 文档 / 构建 / 告警" },
  { label: "已连接", value: String(connectedCount), accent: "bg-success-500", icon: <IconPlug className="size-4" />, trend: `${SERVERS.length - connectedCount} 个待处理` },
  { label: "已发现工具", value: String(totalTools), accent: "bg-info-500", icon: <IconWrench className="size-4" />, trend: "物化为 <mcp-plugin>.<tool>" },
];

/* ---------- 新建服务弹窗（纯 UI） ---------- */

function CreateServerModal({
  onClose,
  mobile,
}: {
  onClose: () => void;
  mobile: boolean;
}) {
  const [type, setType] = useState<McpType>("http");
  return (
    <div
      className={`fixed inset-0 z-50 ${mobile ? "flex items-end" : "flex items-center justify-center"} bg-slate-900/40 ${mobile ? "" : "p-4"}`}
      role="dialog"
      aria-modal="true"
      aria-label="新建 MCP 服务"
      onClick={onClose}
    >
      <div
        className={`w-full bg-white shadow-frame ${mobile ? "max-h-[92vh] overflow-y-auto rounded-t-[--radius-card] border-t border-x border-slate-200" : "max-w-lg rounded-[--radius-card] border border-slate-200"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <IconPlug className="size-4 text-brand-600" />
            <h3 className="text-sm font-semibold text-slate-900">新建 MCP 服务</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">服务名称</label>
            <input
              type="text"
              placeholder="如 my-company-mcp"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">连接类型</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as McpType)}
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="http">远程 HTTP（URL 连接）</option>
              <option value="stdio">本地 stdio（启动命令）</option>
            </select>
          </div>
          {type === "http" ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">服务 URL</label>
              <input
                type="text"
                placeholder="https://mcp.example.com/mcp"
                className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">启动命令</label>
                <input
                  type="text"
                  placeholder="npx -y @scope/mcp-server"
                  className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">启动参数（可选）</label>
                <input
                  type="text"
                  placeholder="--token ${KETA_DB_TOKEN}"
                  className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
            </>
          )}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">认证方式</label>
            <select
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              defaultValue="none"
            >
              <option value="none">无</option>
              <option value="bearer">Bearer Token</option>
              <option value="oauth">OAuth 2.0</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">Token（认证为 Bearer 时）</label>
            <input
              type="password"
              placeholder="粘贴访问 Token…"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p className="mt-1 text-[11px] text-slate-400">Token 加密存储，可引用平台凭证（如 {'${KETA_GITHUB_TOKEN}'}）</p>
          </div>
          <label className="flex cursor-pointer items-center justify-between rounded-[--radius-control] border border-slate-200 bg-slate-50/60 px-3 py-2.5">
            <span className="text-xs font-medium text-slate-700">注册后立即连接并发现工具</span>
            <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-brand-600">
              <span className="ml-auto mr-0.5 inline-block size-4 rounded-full bg-white shadow-sm" />
            </span>
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onClose}>
            <IconPlus className="size-4" />
            新建服务
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 工具清单（行展开） ---------- */

function ToolList({ tools, mobile }: { tools: McpTool[]; mobile: boolean }) {
  if (mobile) {
    return (
      <ul className="space-y-2.5">
        {tools.map((t) => (
          <li key={t.name} className="rounded-[--radius-control] border border-slate-100 bg-slate-50/70 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="font-mono text-xs font-semibold text-slate-800">{t.name}</p>
              {t.risk === "high" && <StatusBadge tone="warning">高风险 · 已接入工具级审批</StatusBadge>}
            </div>
            <p className="mb-1.5 text-xs text-slate-500">{t.desc}</p>
            <p className="font-mono text-[11px] text-slate-400">参数：{t.params}</p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-hidden rounded-[--radius-control] border border-slate-100">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] text-slate-500">
            <th className="px-4 py-2 font-medium">工具名</th>
            <th className="px-4 py-2 font-medium">说明</th>
            <th className="px-4 py-2 font-medium">参数摘要</th>
            <th className="px-4 py-2 font-medium">风险</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
              <td className="px-4 py-2 font-mono font-medium text-slate-800">{t.name}</td>
              <td className="px-4 py-2 text-slate-500">{t.desc}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-slate-400">{t.params}</td>
              <td className="px-4 py-2">
                {t.risk === "high" ? (
                  <StatusBadge tone="warning">高风险 · 已接入工具级审批</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral" dot={false}>普通</StatusBadge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 页面 ---------- */

export default function McpServerPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleTest = (id: string) => {
    if (testingId) return;
    setTestingId(id);
    timerRef.current = setTimeout(() => setTestingId(null), 1800);
  };

  const filtered = SERVERS.filter((s) => {
    const q = query.trim().toLowerCase();
    return q === "" || s.name.toLowerCase().includes(q) || s.endpoint.toLowerCase().includes(q);
  });

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">MCP 服务管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            连接外部 MCP Server，自动发现工具并物化为平台工具，供 Agent 白名单引用
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <IconPlus className="size-4" />
          新建 MCP 服务
        </Button>
      </div>

      {/* 统计条 */}
      <div className={`mb-4 grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-3"}`}>
        {STATS.map((s) => (
          <div
            key={s.label}
            className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="flex size-8 items-center justify-center rounded-[--radius-control] bg-slate-50 text-slate-500 ring-1 ring-slate-200">
                {s.icon}
              </div>
              <span className={`h-1 w-6 rounded-full ${s.accent}`} />
            </div>
            <p className="text-2xl font-semibold tracking-tight text-slate-900">{s.value}</p>
            <p className="mt-0.5 text-xs text-slate-500">{s.label}</p>
            <p className="mt-1 font-mono text-[11px] text-slate-400">{s.trend}</p>
          </div>
        ))}
      </div>

      {/* 搜索框 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-96"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索服务名称 / 连接地址…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <p className={`text-[11px] text-slate-400 ${mobile ? "" : "ml-auto"}`}>
          共 {SERVERS.length} 个服务 · {totalTools} 个已发现工具
        </p>
      </div>

      {/* 列表：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {filtered.map((s) => (
            <li key={s.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
                  <IconServer className="size-4 shrink-0 text-slate-400" />
                  <span className="truncate">{s.name}</span>
                </p>
                <StatusBadge tone={STATUS_META[s.status].tone}>{STATUS_META[s.status].label}</StatusBadge>
              </div>
              <p className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <StatusBadge tone={TYPE_META[s.type].tone} dot={false}>{TYPE_META[s.type].label}</StatusBadge>
                <span className="font-mono">{s.endpoint}</span>
              </p>
              <dl className="space-y-1.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                <div className="flex items-center justify-between">
                  <dt>已发现工具</dt>
                  <dd className="font-mono text-slate-700">{s.tools.length} 个</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>认证方式</dt>
                  <dd>
                    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                      <IconKey className="size-3" />
                      {AUTH_META[s.auth]}
                    </span>
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>更新时间</dt>
                  <dd className="font-mono text-slate-700">{s.updated}</dd>
                </div>
              </dl>
              {expandedId === s.id && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <p className="mb-2 text-xs font-medium text-slate-600">
                    自动发现工具（{s.tools.length}）
                  </p>
                  <ToolList tools={s.tools} mobile />
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 px-2 py-1.5 text-xs"
                  onClick={() => handleTest(s.id)}
                  disabled={testingId !== null}
                >
                  <IconRefresh className={`size-3.5 ${testingId === s.id ? "animate-spin" : ""}`} />
                  {testingId === s.id ? "测试中…" : "测试连接"}
                </Button>
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs" onClick={() => toggleExpand(s.id)}>
                  {expandedId === s.id ? "收起工具" : "查看工具"}
                </Button>
              </div>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-12 text-center text-sm text-slate-400">
              没有符合条件的 MCP 服务
            </li>
          )}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">服务</th>
                <th className="px-4 py-2.5 font-medium">连接地址 / 启动命令</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">已发现工具</th>
                <th className="px-4 py-2.5 font-medium">认证</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <Fragment key={s.id}>
                  <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpand(s.id)}
                          className="flex size-5 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          aria-label={expandedId === s.id ? "收起工具" : "展开工具"}
                        >
                          <IconChevronDown
                            className={`size-3.5 transition-transform ${expandedId === s.id ? "rotate-180" : ""}`}
                          />
                        </button>
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-[--radius-control] bg-slate-50 text-slate-500 ring-1 ring-slate-200">
                          <IconServer className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate font-medium text-slate-900">
                            {s.name}
                          </p>
                          <p className="font-mono text-[11px] text-slate-400">{s.id}</p>
                        </div>
                        <StatusBadge tone={TYPE_META[s.type].tone} dot={false}>
                          {TYPE_META[s.type].label}
                        </StatusBadge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block max-w-52 truncate rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600" title={s.endpoint}>
                        {s.endpoint}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={STATUS_META[s.status].tone}>{STATUS_META[s.status].label}</StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleExpand(s.id)}
                        className="font-mono text-xs font-medium text-brand-600 hover:underline"
                      >
                        {s.tools.length} 个工具
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                        <IconKey className="size-3" />
                        {AUTH_META[s.auth]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() => handleTest(s.id)}
                          disabled={testingId !== null}
                        >
                          <IconRefresh className={`size-3.5 ${testingId === s.id ? "animate-spin" : ""}`} />
                          {testingId === s.id ? "测试中" : "测试连接"}
                        </Button>
                        <Button variant="ghost" className="px-2 py-1 text-xs">编辑</Button>
                        <Button variant="ghost" className="px-2 py-1 text-xs text-danger-600 hover:bg-danger-50">删除</Button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === s.id && (
                    <tr className="border-b border-slate-100 bg-slate-50/40 last:border-0">
                      <td colSpan={6} className="px-4 py-3">
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                          <IconWrench className="size-3.5 text-brand-600" />
                          自动发现工具（{s.tools.length}）· 高风险工具已接入工具级审批
                        </p>
                        <ToolList tools={s.tools} mobile={false} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的 MCP 服务
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 页脚提示 */}
      <p className="mt-4 text-center text-[11px] text-slate-400">
        平台按需拉起 MCP 进程、保活与回收；工具仅在 Agent 白名单授权后可用
      </p>

      {/* 新建弹窗 */}
      {showCreate && <CreateServerModal onClose={() => setShowCreate(false)} mobile={mobile} />}
    </div>
  );
}
