import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconRefresh, IconSearch, StatusBadge, type Tone } from "../_shared/ui";

/**
 * 工具管理页原型（组：生态）
 * =====================================================
 * 模拟"平台所有已注册工具的统一下沉视图"：
 * 顶部标题 + 搜索 + 来源筛选（内置 / 插件 / MCP），
 * 统计条（总工具 / 高风险工具 / 被引用 Agent），
 * PC 表格 / 移动端卡片列出平台工具（全名 <plugin>.<tool>），
 * 行展开查看引用该工具的 Agent 列表（命名空间 + 权限状态），
 * "查看详情"弹窗展示参数 Schema、配置项引用与所属插件配置。
 * 纯 UI 原型：搜索 / 筛选 / 展开 / 弹窗 / switch / 停用删除为本地交互。
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

const IconWrench = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Icon>
);

const IconBox = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Icon>
);

const IconShield = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </Icon>
);

const IconUsers = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

const IconKey = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m11 12 9-9M16 7l2 2M18 5l2 2" />
  </Icon>
);

const IconPlug = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 22v-5" />
    <path d="M9 8V2M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </Icon>
);

const IconChevronDown = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const IconClose = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

const IconExternalLink = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

/* ---------- 数据 ---------- */

type ToolSource = "builtin" | "plugin" | "mcp";
type ToolRisk = "normal" | "high";
type RefPermission = "granted" | "pending";

interface ToolRef {
  agent: string;
  namespace: string;
  permission: RefPermission;
}

interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  desc: string;
}

interface ToolConfigRef {
  name: string;
  from: string;
}

interface Tool {
  id: string;
  fullName: string;
  source: ToolSource;
  owner: string;
  ownerDetail: string;
  risk: ToolRisk;
  desc: string;
  refs: ToolRef[];
  enabled: boolean;
  params: ToolParam[];
  configRefs: ToolConfigRef[];
}

const TOOLS: Tool[] = [
  {
    id: "github.create_pr",
    fullName: "github.create_pr",
    source: "mcp",
    owner: "github-mcp",
    ownerDetail: "MCP 服务 github-mcp · https://mcp.github.com/mcp",
    risk: "normal",
    desc: "创建 Pull Request，支持草稿模式与指定评审人",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "granted" },
      { agent: "code-reviewer", namespace: "ns/dev", permission: "granted" },
      { agent: "issue-triage", namespace: "ns/dev", permission: "granted" },
    ],
    params: [
      { name: "owner", type: "string", required: true, desc: "仓库属主" },
      { name: "repo", type: "string", required: true, desc: "仓库名" },
      { name: "title", type: "string", required: true, desc: "PR 标题" },
      { name: "head", type: "string", required: true, desc: "源分支" },
      { name: "base", type: "string", required: true, desc: "目标分支" },
      { name: "body", type: "string", required: false, desc: "PR 描述" },
    ],
    configRefs: [
      { name: "GITHUB_TOKEN", from: "凭证 github-token" },
      { name: "serverUrl", from: "MCP 服务配置" },
    ],
  },
  {
    id: "github.list_issues",
    fullName: "github.list_issues",
    source: "mcp",
    owner: "github-mcp",
    ownerDetail: "MCP 服务 github-mcp · https://mcp.github.com/mcp",
    risk: "normal",
    desc: "按状态 / 标签列出仓库 Issue",
    enabled: true,
    refs: [
      { agent: "code-reviewer", namespace: "ns/dev", permission: "granted" },
      { agent: "issue-triage", namespace: "ns/dev", permission: "granted" },
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
      { agent: "doc-writer", namespace: "ns/dev", permission: "granted" },
      { agent: "devops-agent", namespace: "ns/prod", permission: "granted" },
    ],
    params: [
      { name: "owner", type: "string", required: true, desc: "仓库属主" },
      { name: "repo", type: "string", required: true, desc: "仓库名" },
      { name: "state", type: "enum", required: false, desc: "open / closed / all" },
      { name: "labels", type: "string", required: false, desc: "逗号分隔的标签" },
      { name: "per_page", type: "integer", required: false, desc: "每页条数，默认 30" },
    ],
    configRefs: [
      { name: "GITHUB_TOKEN", from: "凭证 github-token" },
      { name: "serverUrl", from: "MCP 服务配置" },
    ],
  },
  {
    id: "github.delete_repo",
    fullName: "github.delete_repo",
    source: "mcp",
    owner: "github-mcp",
    ownerDetail: "MCP 服务 github-mcp · https://mcp.github.com/mcp",
    risk: "high",
    desc: "永久删除仓库（高危操作，需二次确认与审批）",
    enabled: false,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "pending" },
    ],
    params: [
      { name: "owner", type: "string", required: true, desc: "仓库属主" },
      { name: "repo", type: "string", required: true, desc: "仓库名" },
      { name: "confirm", type: "boolean", required: true, desc: "二次确认删除" },
    ],
    configRefs: [
      { name: "GITHUB_TOKEN", from: "凭证 github-token" },
      { name: "serverUrl", from: "MCP 服务配置" },
    ],
  },
  {
    id: "jenkins.trigger_build",
    fullName: "jenkins.trigger_build",
    source: "plugin",
    owner: "jenkins",
    ownerDetail: "插件 jenkins v2.3.0 · 全局设置 baseUrl / apiToken",
    risk: "high",
    desc: "触发 Jenkins 流水线构建，可传入构建参数",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "pending" },
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
    ],
    params: [
      { name: "job_name", type: "string", required: true, desc: "Jenkins 任务名" },
      { name: "parameters", type: "object", required: false, desc: "构建参数键值对" },
      { name: "wait", type: "boolean", required: false, desc: "是否等待构建完成" },
    ],
    configRefs: [
      { name: "JENKINS_URL", from: "全局设置" },
      { name: "JENKINS_TOKEN", from: "凭证 jenkins-token" },
    ],
  },
  {
    id: "jenkins.get_build_status",
    fullName: "jenkins.get_build_status",
    source: "plugin",
    owner: "jenkins",
    ownerDetail: "插件 jenkins v2.3.0 · 全局设置 baseUrl / apiToken",
    risk: "normal",
    desc: "查询 Jenkins 构建状态与执行结果",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "granted" },
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
      { agent: "devops-agent", namespace: "ns/prod", permission: "granted" },
      { agent: "data-analyst", namespace: "ns/analytics", permission: "granted" },
    ],
    params: [
      { name: "job_name", type: "string", required: true, desc: "Jenkins 任务名" },
      { name: "build_number", type: "integer", required: false, desc: "构建号，默认最新" },
    ],
    configRefs: [
      { name: "JENKINS_URL", from: "全局设置" },
      { name: "JENKINS_TOKEN", from: "凭证 jenkins-token" },
    ],
  },
  {
    id: "gitee.create_pr",
    fullName: "gitee.create_pr",
    source: "plugin",
    owner: "gitee",
    ownerDetail: "插件 gitee v1.8.0 · 全局设置 baseUrl",
    risk: "normal",
    desc: "在 Gitee 仓库创建 Pull Request",
    enabled: true,
    refs: [
      { agent: "issue-triage", namespace: "ns/dev", permission: "granted" },
    ],
    params: [
      { name: "owner", type: "string", required: true, desc: "仓库属主" },
      { name: "repo", type: "string", required: true, desc: "仓库名" },
      { name: "title", type: "string", required: true, desc: "PR 标题" },
      { name: "head", type: "string", required: true, desc: "源分支" },
      { name: "base", type: "string", required: true, desc: "目标分支" },
    ],
    configRefs: [
      { name: "GITEE_TOKEN", from: "凭证 gitee-token" },
      { name: "serverUrl", from: "插件配置" },
    ],
  },
  {
    id: "web_search",
    fullName: "web_search",
    source: "builtin",
    owner: "内置运行时",
    ownerDetail: "内置工具 · 平台运行时提供，无需安装",
    risk: "normal",
    desc: "调用搜索引擎获取实时网页结果",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "granted" },
      { agent: "code-reviewer", namespace: "ns/dev", permission: "granted" },
      { agent: "issue-triage", namespace: "ns/dev", permission: "granted" },
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
      { agent: "doc-writer", namespace: "ns/dev", permission: "granted" },
      { agent: "data-analyst", namespace: "ns/analytics", permission: "granted" },
      { agent: "sentry-monitor", namespace: "ns/ops", permission: "granted" },
      { agent: "devops-agent", namespace: "ns/prod", permission: "granted" },
    ],
    params: [
      { name: "query", type: "string", required: true, desc: "搜索关键词" },
      { name: "num_results", type: "integer", required: false, desc: "返回条数，默认 10" },
      { name: "region", type: "string", required: false, desc: "地域偏好" },
    ],
    configRefs: [
      { name: "SEARCH_ENGINE", from: "全局设置" },
    ],
  },
  {
    id: "git_commit",
    fullName: "git_commit",
    source: "builtin",
    owner: "内置运行时",
    ownerDetail: "内置工具 · 平台运行时提供，无需安装",
    risk: "normal",
    desc: "在当前工作区执行 git 提交（支持 author 覆盖）",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "granted" },
      { agent: "code-reviewer", namespace: "ns/dev", permission: "granted" },
      { agent: "issue-triage", namespace: "ns/dev", permission: "granted" },
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
      { agent: "doc-writer", namespace: "ns/dev", permission: "granted" },
      { agent: "devops-agent", namespace: "ns/prod", permission: "granted" },
    ],
    params: [
      { name: "message", type: "string", required: true, desc: "提交信息" },
      { name: "files", type: "string[]", required: false, desc: "待提交文件列表" },
      { name: "branch", type: "string", required: false, desc: "目标分支" },
      { name: "author", type: "string", required: false, desc: "覆盖提交人" },
    ],
    configRefs: [
      { name: "GIT_AUTHOR", from: "全局设置" },
    ],
  },
  {
    id: "mcp_db_query",
    fullName: "mcp_db_query",
    source: "mcp",
    owner: "internal-db-mcp",
    ownerDetail: "MCP 服务 internal-db-mcp · 本地 stdio（npx @internal/db-mcp-server）",
    risk: "normal",
    desc: "对内部数据库执行只读 SQL 查询",
    enabled: true,
    refs: [
      { agent: "ci-pipeline", namespace: "ns/prod", permission: "granted" },
      { agent: "data-analyst", namespace: "ns/analytics", permission: "granted" },
    ],
    params: [
      { name: "sql", type: "string", required: true, desc: "只读 SQL 语句" },
      { name: "database", type: "string", required: true, desc: "目标数据库" },
      { name: "limit", type: "integer", required: false, desc: "返回行数上限" },
    ],
    configRefs: [
      { name: "DB_URL", from: "凭证 internal-db" },
      { name: "DB_READONLY_USER", from: "凭证 internal-db" },
    ],
  },
  {
    id: "sentry.list_issues",
    fullName: "sentry.list_issues",
    source: "mcp",
    owner: "sentry-mcp",
    ownerDetail: "MCP 服务 sentry-mcp · https://mcp.sentry.io/mcp",
    risk: "normal",
    desc: "列出 Sentry 项目的错误事件",
    enabled: true,
    refs: [
      { agent: "sentry-monitor", namespace: "ns/ops", permission: "granted" },
    ],
    params: [
      { name: "project", type: "string", required: true, desc: "Sentry 项目" },
      { name: "query", type: "string", required: false, desc: "事件过滤条件" },
      { name: "limit", type: "integer", required: false, desc: "返回条数" },
    ],
    configRefs: [
      { name: "SENTRY_TOKEN", from: "凭证 sentry-token" },
    ],
  },
  {
    id: "jenkins.delete_job",
    fullName: "jenkins.delete_job",
    source: "plugin",
    owner: "jenkins",
    ownerDetail: "插件 jenkins v2.3.0 · 全局设置 baseUrl / apiToken",
    risk: "high",
    desc: "删除 Jenkins 任务（不可恢复，需审批）",
    enabled: false,
    refs: [],
    params: [
      { name: "job_name", type: "string", required: true, desc: "Jenkins 任务名" },
      { name: "confirm", type: "boolean", required: true, desc: "二次确认删除" },
    ],
    configRefs: [
      { name: "JENKINS_URL", from: "全局设置" },
      { name: "JENKINS_TOKEN", from: "凭证 jenkins-token" },
    ],
  },
  {
    id: "k8s_apply",
    fullName: "k8s_apply",
    source: "builtin",
    owner: "内置运行时",
    ownerDetail: "内置工具 · 平台运行时提供，需配置 kubeconfig",
    risk: "high",
    desc: "向 Kubernetes 集群应用 manifest（生产敏感）",
    enabled: true,
    refs: [
      { agent: "release-ops", namespace: "ns/prod", permission: "pending" },
    ],
    params: [
      { name: "manifest", type: "object", required: true, desc: "K8s 资源清单" },
      { name: "namespace", type: "string", required: false, desc: "目标命名空间" },
      { name: "dry_run", type: "boolean", required: false, desc: "仅校验不应用" },
    ],
    configRefs: [
      { name: "K8S_KUBECONFIG", from: "凭证 k8s-config" },
    ],
  },
];

const SOURCE_META: Record<ToolSource, { label: string; tone: Tone }> = {
  builtin: { label: "内置", tone: "brand" },
  plugin: { label: "插件", tone: "info" },
  mcp: { label: "MCP", tone: "success" },
};

type SourceFilter = "all" | ToolSource;

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "builtin", label: "内置" },
  { value: "plugin", label: "插件" },
  { value: "mcp", label: "MCP" },
];

function sourceCount(s: SourceFilter) {
  return s === "all" ? TOOLS.length : TOOLS.filter((t) => t.source === s).length;
}

const PERM_META: Record<RefPermission, { label: string; tone: Tone }> = {
  granted: { label: "已授权", tone: "success" },
  pending: { label: "需审批", tone: "warning" },
};

const totalTools = TOOLS.length;
const highRiskCount = TOOLS.filter((t) => t.risk === "high").length;
const agentCount = new Set(TOOLS.flatMap((t) => t.refs.map((r) => r.agent))).size;
const nsCount = new Set(TOOLS.flatMap((t) => t.refs.map((r) => r.namespace))).size;

const STATS = [
  {
    label: "总工具数",
    value: String(totalTools),
    accent: "bg-brand-500",
    icon: <IconBox className="size-4" />,
    trend: "内置 / 插件 / MCP 三类来源",
  },
  {
    label: "高风险工具数",
    value: String(highRiskCount),
    accent: "bg-danger-500",
    icon: <IconShield className="size-4" />,
    trend: "调用需工具级审批（ToolApproval）",
  },
  {
    label: "被引用 Agent 数",
    value: String(agentCount),
    accent: "bg-info-500",
    icon: <IconUsers className="size-4" />,
    trend: `跨 ${nsCount} 个命名空间 · 白名单引用（FR-203）`,
  },
];

/* ---------- 纯 UI switch ---------- */

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        on ? "bg-brand-600" : "bg-slate-200"
      }`}
      aria-label={on ? "已启用" : "已停用"}
    >
      <span
        className={`inline-block size-4 rounded-full bg-white shadow-sm transition-transform ${
          on ? "ml-auto mr-0.5" : "ml-0.5"
        }`}
      />
    </button>
  );
}

/* ---------- 引用 Agent 列表（行展开） ---------- */

function RefList({ refs, mobile }: { refs: ToolRef[]; mobile: boolean }) {
  if (refs.length === 0) {
    return (
      <p className="rounded-[--radius-control] border border-dashed border-slate-200 bg-white/60 px-3 py-4 text-center text-xs text-slate-400">
        暂无 Agent 引用，工具仅对白名单授权后可用
      </p>
    );
  }
  if (mobile) {
    return (
      <ul className="space-y-1.5">
        {refs.map((r) => (
          <li key={r.agent} className="flex items-center justify-between gap-2 rounded-[--radius-control] border border-slate-100 bg-white px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-xs font-medium text-slate-800">{r.agent}</p>
              <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{r.namespace}</span>
            </div>
            <StatusBadge tone={PERM_META[r.permission].tone} dot={false}>
              {PERM_META[r.permission].label}
            </StatusBadge>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-hidden rounded-[--radius-control] border border-slate-100 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] text-slate-500">
            <th className="px-3 py-1.5 font-medium">Agent</th>
            <th className="px-3 py-1.5 font-medium">命名空间</th>
            <th className="px-3 py-1.5 font-medium">权限状态</th>
          </tr>
        </thead>
        <tbody>
          {refs.map((r) => (
            <tr key={r.agent} className="border-b border-slate-50 last:border-0">
              <td className="px-3 py-1.5 font-medium text-slate-800">{r.agent}</td>
              <td className="px-3 py-1.5">
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{r.namespace}</span>
              </td>
              <td className="px-3 py-1.5">
                <StatusBadge tone={PERM_META[r.permission].tone} dot={false}>
                  {PERM_META[r.permission].label}
                </StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 工具详情弹窗（纯 UI） ---------- */

function ToolDetailModal({ tool, onClose, mobile }: { tool: Tool; onClose: () => void; mobile: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-50 ${mobile ? "flex items-end" : "flex items-center justify-center"} bg-slate-900/40 ${mobile ? "" : "p-4"}`}
      role="dialog"
      aria-modal="true"
      aria-label={`工具详情 ${tool.fullName}`}
      onClick={onClose}
    >
      <div
        className={`w-full bg-white shadow-frame ${mobile ? "max-h-[92vh] overflow-y-auto rounded-t-[--radius-card] border-t border-x border-slate-200" : "max-w-2xl rounded-[--radius-card] border border-slate-200"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <IconWrench className="size-4 shrink-0 text-brand-600" />
              <h3 className="font-mono text-sm font-semibold text-slate-900">{tool.fullName}</h3>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={SOURCE_META[tool.source].tone} dot={false}>
                {SOURCE_META[tool.source].label}
              </StatusBadge>
              {tool.risk === "high" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-danger-50 px-2.5 py-0.5 text-xs font-medium text-danger-700 ring-1 ring-inset ring-danger-500/20">
                  <IconShield className="size-3" />
                  高风险 · 需审批
                </span>
              ) : (
                <StatusBadge tone="neutral" dot={false}>普通</StatusBadge>
              )}
              <span className="text-[11px] text-slate-400">{tool.ownerDetail}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <IconClose className="size-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <div>
            <p className="mb-2 text-xs font-medium text-slate-600">说明</p>
            <p className="text-sm leading-relaxed text-slate-500">{tool.desc}</p>
          </div>

          {/* 参数 Schema */}
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <IconWrench className="size-3.5 text-brand-600" />
              参数 Schema（{tool.params.length}）
            </p>
            {mobile ? (
              <ul className="space-y-2">
                {tool.params.map((p) => (
                  <li key={p.name} className="rounded-[--radius-control] border border-slate-100 bg-slate-50/70 p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-slate-800">{p.name}</span>
                      <span className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[10px] text-slate-600">{p.type}</span>
                      {p.required ? (
                        <span className="text-[10px] font-medium text-danger-600">必填</span>
                      ) : (
                        <span className="text-[10px] text-slate-400">可选</span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">{p.desc}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="overflow-hidden rounded-[--radius-control] border border-slate-100">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] text-slate-500">
                      <th className="px-3 py-2 font-medium">参数名</th>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">必填</th>
                      <th className="px-3 py-2 font-medium">描述</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tool.params.map((p) => (
                      <tr key={p.name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                        <td className="px-3 py-2 font-mono font-medium text-slate-800">{p.name}</td>
                        <td className="px-3 py-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{p.type}</span>
                        </td>
                        <td className="px-3 py-2">
                          {p.required ? (
                            <span className="font-medium text-danger-600">必填</span>
                          ) : (
                            <span className="text-slate-400">可选</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{p.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 配置项引用 */}
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <IconKey className="size-3.5 text-brand-600" />
              配置项引用（{tool.configRefs.length}）
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {tool.configRefs.map((c) => (
                <li key={c.name} className="flex items-center gap-2 rounded-[--radius-control] border border-slate-100 bg-slate-50/70 px-3 py-2">
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                    <IconKey className="size-3" />
                    {c.name}
                  </span>
                  <span className="truncate text-[11px] text-slate-500">{c.from}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 所属插件 / 服务 */}
          <div className="flex items-center gap-2 rounded-[--radius-control] border border-slate-100 bg-slate-50/70 px-3 py-2.5">
            <IconPlug className="size-4 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-700">所属 {tool.source === "mcp" ? "MCP 服务" : tool.source === "plugin" ? "插件" : "内置"}</p>
              <p className="truncate font-mono text-[11px] text-slate-500">{tool.ownerDetail}</p>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>
            <IconExternalLink className="size-3.5" />
            查看所属 {tool.source === "mcp" ? "MCP 服务" : tool.source === "plugin" ? "插件" : "配置"}
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 页面 ---------- */

export default function ToolManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TOOLS.map((t) => [t.id, t.enabled])),
  );

  const filtered = TOOLS.filter((t) => {
    const q = query.trim().toLowerCase();
    const matchQ =
      q === "" ||
      t.fullName.toLowerCase().includes(q) ||
      t.desc.toLowerCase().includes(q) ||
      t.owner.toLowerCase().includes(q);
    const matchS = source === "all" || t.source === source;
    return matchQ && matchS;
  });

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const toggleEnabled = (id: string) => {
    setEnabledMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const detailTool = detailId ? TOOLS.find((t) => t.id === detailId) ?? null : null;

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">工具管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            平台已注册工具的统一下沉视图：来源包括内置、插件声明与 MCP 自动发现，供 Agent 白名单引用
          </p>
        </div>
        <Button variant="outline">
          <IconRefresh className="size-4" />
          刷新工具清单
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

      {/* 搜索 + 来源筛选 */}
      <div
        className={`mb-4 flex gap-3 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${
          mobile ? "flex-col" : "items-center"
        }`}
      >
        <div className={`relative ${mobile ? "w-full" : "w-96 shrink-0"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工具全名 / 描述 / 所属服务…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <div className={`flex gap-1.5 overflow-x-auto pb-0.5 ${mobile ? "w-full" : "ml-auto"}`}>
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSource(f.value)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors ${
                source === f.value
                  ? "bg-brand-600 font-medium text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
              <span
                className={`ml-1 text-[10px] ${
                  source === f.value ? "text-brand-100" : "text-slate-400"
                }`}
              >
                {sourceCount(f.value)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 列表：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {filtered.map((t) => (
            <li key={t.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2 font-mono text-[13px] font-semibold text-slate-900">
                  <IconWrench className="size-4 shrink-0 text-slate-400" />
                  <span className="truncate">{t.fullName}</span>
                </p>
                <StatusBadge tone={SOURCE_META[t.source].tone} dot={false}>
                  {SOURCE_META[t.source].label}
                </StatusBadge>
              </div>
              <p className="mb-2.5 text-[13px] leading-relaxed text-slate-500">{t.desc}</p>
              <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                  <IconPlug className="size-3" />
                  {t.owner}
                </span>
                {t.risk === "high" ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-danger-50 px-2 py-0.5 text-[11px] font-medium text-danger-700 ring-1 ring-inset ring-danger-500/20">
                    <IconShield className="size-3" />
                    高风险 · 需审批
                  </span>
                ) : (
                  <StatusBadge tone="neutral" dot={false}>普通</StatusBadge>
                )}
              </p>

              <div className="mb-3 flex items-center justify-between border-t border-slate-100 pt-2.5">
                <button
                  type="button"
                  onClick={() => toggleExpand(t.id)}
                  className={`flex items-center gap-1 text-xs font-medium ${
                    t.refs.length > 0 ? "text-brand-600 hover:underline" : "text-slate-400"
                  }`}
                >
                  <IconUsers className="size-3.5" />
                  {t.refs.length > 0 ? `被 ${t.refs.length} 个 Agent 引用` : "未被引用"}
                  {t.refs.length > 0 && (
                    <IconChevronDown
                      className={`size-3 transition-transform ${expandedId === t.id ? "rotate-180" : ""}`}
                    />
                  )}
                </button>
                <Toggle on={enabledMap[t.id]} onClick={() => toggleEnabled(t.id)} />
              </div>

              {expandedId === t.id && (
                <div className="mb-3 border-t border-slate-100 pt-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    <IconUsers className="size-3.5 text-brand-600" />
                    引用该工具的 Agent（{t.refs.length}）
                    {t.risk === "high" && <span className="text-[10px] font-normal text-slate-400">· 高风险工具每次调用需审批</span>}
                  </p>
                  <RefList refs={t.refs} mobile />
                </div>
              )}

              <div className="flex gap-2 border-t border-slate-100 pt-3">
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs" onClick={() => setDetailId(t.id)}>
                  <IconWrench className="size-3.5" />
                  查看详情
                </Button>
                <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs" onClick={() => toggleEnabled(t.id)}>
                  {enabledMap[t.id] ? "停用" : "启用"}
                </Button>
                <Button variant="ghost" className="px-2 py-1.5 text-xs text-danger-600 hover:bg-danger-50">
                  删除
                </Button>
              </div>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-12 text-center text-sm text-slate-400">
              没有符合条件的工具
            </li>
          )}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">工具</th>
                <th className="px-4 py-2.5 font-medium">来源</th>
                <th className="px-4 py-2.5 font-medium">所属插件 / 服务</th>
                <th className="px-4 py-2.5 font-medium">风险</th>
                <th className="px-4 py-2.5 font-medium">描述</th>
                <th className="px-4 py-2.5 font-medium">Agent 引用</th>
                <th className="px-4 py-2.5 font-medium">启用</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <FragmentRow
                  key={t.id}
                  tool={t}
                  enabled={enabledMap[t.id]}
                  expanded={expandedId === t.id}
                  onToggleExpand={() => toggleExpand(t.id)}
                  onToggleEnabled={() => toggleEnabled(t.id)}
                  onOpenDetail={() => setDetailId(t.id)}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的工具
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 页脚提示 */}
      <p className="mt-4 text-center text-[11px] text-slate-400">
        工具由插件 declaredTools 或 MCP 自动发现物化而来；高风险工具调用前需通过工具级审批（ToolApproval）
      </p>

      {/* 详情弹窗 */}
      {detailTool && <ToolDetailModal tool={detailTool} onClose={() => setDetailId(null)} mobile={mobile} />}
    </div>
  );
}

/* ---------- PC 表格行（含展开） ---------- */

function FragmentRow({
  tool,
  enabled,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onOpenDetail,
}: {
  tool: Tool;
  enabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onOpenDetail: () => void;
}) {
  return (
    <Fragment>
      <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleExpand}
              disabled={tool.refs.length === 0}
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
              aria-label={expanded ? "收起引用" : "展开引用"}
            >
              <IconChevronDown
                className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-[--radius-control] bg-slate-50 text-slate-500 ring-1 ring-slate-200">
              <IconWrench className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-semibold text-slate-900">{tool.fullName}</p>
              <p className="font-mono text-[11px] text-slate-400">{tool.id}</p>
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <StatusBadge tone={SOURCE_META[tool.source].tone} dot={false}>
            {SOURCE_META[tool.source].label}
          </StatusBadge>
        </td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
            <IconPlug className="size-3" />
            {tool.owner}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={tool.risk === "high" ? "danger" : "neutral"} dot={false}>
              {tool.risk === "high" ? "高风险" : "普通"}
            </StatusBadge>
            {tool.risk === "high" && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-danger-50 px-1.5 py-0.5 text-[10px] font-medium text-danger-700 ring-1 ring-inset ring-danger-500/20">
                <IconShield className="size-2.5" />
                需审批
              </span>
            )}
          </div>
        </td>
        <td className="max-w-48 px-4 py-3">
          <p className="truncate text-xs text-slate-500" title={tool.desc}>
            {tool.desc}
          </p>
        </td>
        <td className="px-4 py-3">
          {tool.refs.length > 0 ? (
            <button
              type="button"
              onClick={onToggleExpand}
              className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
            >
              <IconUsers className="size-3.5" />
              {tool.refs.length} 个 Agent
            </button>
          ) : (
            <span className="text-xs text-slate-400">未引用</span>
          )}
        </td>
        <td className="px-4 py-3">
          <Toggle on={enabled} onClick={onToggleEnabled} />
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onOpenDetail}>
              查看详情
            </Button>
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onToggleEnabled}>
              {enabled ? "停用" : "启用"}
            </Button>
            <Button variant="ghost" className="px-2 py-1 text-xs text-danger-600 hover:bg-danger-50">
              删除
            </Button>
          </div>
        </td>
      </tr>
      {expanded && tool.refs.length > 0 && (
        <tr className="border-b border-slate-100 bg-slate-50/40 last:border-0">
          <td colSpan={8} className="px-4 py-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
              <IconUsers className="size-3.5 text-brand-600" />
              引用该工具的 Agent（{tool.refs.length}）
              {tool.risk === "high" && <span className="text-[10px] font-normal text-slate-400">· 高风险工具每次调用需审批</span>}
            </p>
            <RefList refs={tool.refs} mobile={false} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
