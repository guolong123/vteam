import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Avatar, Button, IconSearch, StatusBadge } from "../_shared/ui";

/**
 * 审计日志页原型（组：设置，namespace-manage 后 settings 之前）
 * =====================================================
 * 筛选行（操作类型 / 操作者 / 时间范围）+ 导出按钮；
 * 表格列：时间 / 操作者 / 动作 / 类型 / 命名空间 / 结果 / 详情展开。
 * 行点击展开操作详情（请求信息 / 变更摘要）。纯 UI 交互。
 */

/* ---------- 自包含图标 ---------- */

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

const IconDownload = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </Icon>
);

const IconChevronDown = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const IconShield = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
  </Icon>
);

/* ---------- 数据 ---------- */

type AuditType = "resource" | "task" | "approval" | "auth";

interface AuditRecord {
  id: string;
  time: string;
  operator: string;
  action: string;
  resource: string;
  type: AuditType;
  namespace: string;
  result: "success" | "failed";
  req: string;
  res: string;
}

const AUDITS: AuditRecord[] = [
  {
    id: "aud-1310",
    time: "07-20 10:58",
    operator: "李四",
    action: "审批通过",
    resource: "approval://ap-298 · 集群扩容至 3 节点",
    type: "approval",
    namespace: "default",
    result: "success",
    req: "PATCH /api/v1/approvals/ap-298\n{ decision: \"approve\", comment: \"资源水位合理，同意扩容\" }",
    res: "200 OK\napproval.ap-298: approved\n下游任务 task://tsk-8013 已恢复执行",
  },
  {
    id: "aud-1309",
    time: "07-20 10:41",
    operator: "陈曦",
    action: "启动任务",
    resource: "task://tsk-8025 · 客户门户改版-测试执行",
    type: "task",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/tasks\n{ flow: \"软件公司开发流程 v3\", node: \"测试执行\", trigger: \"manual\" }",
    res: "202 Accepted\ntask.tsk-8025: running · span 14/214",
  },
  {
    id: "aud-1308",
    time: "07-20 10:24",
    operator: "陈曦",
    action: "启动任务",
    resource: "task://tsk-8021 · 发布 ketaops v3.2.1",
    type: "task",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/tasks\n{ flow: \"发布流水线 v4\", trigger: \"manual\" }",
    res: "202 Accepted\ntask.tsk-8021: running · progress 64%",
  },
  {
    id: "aud-1307",
    time: "07-20 09:47",
    operator: "王五",
    action: "提交审批",
    resource: "approval://ap-305 · 需求文档评审 v2",
    type: "approval",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/approvals\n{ checkpoint: \"需求评审\", doc: \"DOC-2026-0716/v2\", round: 3 }",
    res: "201 Created\napproval.ap-305: pending · 等待 李四 审批 · TTL 24h",
  },
  {
    id: "aud-1306",
    time: "07-20 09:12",
    operator: "赵磊",
    action: "创建 Agent",
    resource: "agent://ag-1012 · 发布管家",
    type: "resource",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/agents\n{ name: \"发布管家\", model: \"gpt-5.2\", tools: [jenkins, deploy, docker] }",
    res: "201 Created\nagent.ag-1012: ready · 挂载 8 个工具",
  },
  {
    id: "aud-1305",
    time: "07-19 18:30",
    operator: "林远",
    action: "更新流程",
    resource: "flow://software-dev v3 · 增加验收归档关卡",
    type: "resource",
    namespace: "default",
    result: "success",
    req: "PUT /api/v1/flows/flw-001\n{ version: 3, gates: [需求评审, 验收归档], nodes: 9 }",
    res: "200 OK\nflow.flw-001.v3: draft → published",
  },
  {
    id: "aud-1304",
    time: "07-19 16:05",
    operator: "陈曦",
    action: "发布流程",
    resource: "flow://software-dev v3",
    type: "resource",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/flows/flw-001/publish\n{ version: 3 }",
    res: "200 OK\nflow.flw-001.v3: published · 生效于 07-20 00:00",
  },
  {
    id: "aud-1303",
    time: "07-19 14:22",
    operator: "系统管理员",
    action: "创建命名空间",
    resource: "namespace://test-team",
    type: "resource",
    namespace: "test-team",
    result: "success",
    req: "POST /api/v1/namespaces\n{ name: \"test-team\", quota: { tasks: 50, tokens: \"10M/天\" } }",
    res: "201 Created\nnamespace.test-team: active · 默认配额已分配",
  },
  {
    id: "aud-1302",
    time: "07-19 11:48",
    operator: "王倩",
    action: "重试任务",
    resource: "task://tsk-8012 · 客户门户改版-测试执行",
    type: "task",
    namespace: "default",
    result: "failed",
    req: "POST /api/v1/tasks/tsk-8012/retry\n{ reason: \"build queue timeout\" }",
    res: "502 Bad Gateway\njenkins.query_status: queue timeout · 重试 1 次后仍失败",
  },
  {
    id: "aud-1301",
    time: "07-19 09:15",
    operator: "张三",
    action: "登录认证",
    resource: "admin 控制台 · OIDC 登录",
    type: "auth",
    namespace: "default",
    result: "success",
    req: "POST /api/v1/auth/login\n{ provider: \"oidc\", realm: \"xishuhq\" }",
    res: "200 OK\nsession created · expires 12h · ip 10.20.3.8",
  },
  {
    id: "aud-1300",
    time: "07-18 20:02",
    operator: "李四",
    action: "打回审批",
    resource: "approval://ap-305 · 需求文档 v1",
    type: "approval",
    namespace: "default",
    result: "success",
    req: "PATCH /api/v1/approvals/ap-305\n{ decision: \"reject\", comment: \"缺少明确的验收标准\" }",
    res: "200 OK\napproval.ap-305: rejected → 需求分析 Agent 已收到修改意见",
  },
];

const TYPE_META: Record<AuditType, { text: string; tone: "brand" | "info" | "warning" | "neutral" }> = {
  resource: { text: "资源变更", tone: "brand" },
  task: { text: "任务操作", tone: "info" },
  approval: { text: "审批决策", tone: "warning" },
  auth: { text: "登录认证", tone: "neutral" },
};

const TYPE_FILTERS: Array<{ value: "all" | AuditType; label: string }> = [
  { value: "all", label: "全部" },
  { value: "resource", label: "资源变更" },
  { value: "task", label: "任务操作" },
  { value: "approval", label: "审批决策" },
  { value: "auth", label: "登录认证" },
];

const OPERATOR_OPTIONS = ["全部操作者", "李四", "陈曦", "王五", "赵磊", "林远", "系统管理员", "张三", "王倩"];
const RANGE_OPTIONS = ["今天", "7 天", "30 天"];

/* ---------- 组件 ---------- */

export default function AuditLogPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [typeFilter, setTypeFilter] = useState<"all" | AuditType>("all");
  const [operator, setOperator] = useState(OPERATOR_OPTIONS[0]);
  const [range, setRange] = useState(RANGE_OPTIONS[1]);
  const [expandedId, setExpandedId] = useState<string | null>("aud-1305");

  const toggle = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">审计日志</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            记录所有资源变更、任务操作与审批决策 · 日志保留 180 天
          </p>
        </div>
        <Button variant="outline" className="px-3 py-1.5 text-xs">
          <IconDownload className="size-3.5" />
          导出 CSV
        </Button>
      </div>

      {/* 筛选行 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "flex-wrap items-center"}`}>
        <div className={`flex gap-1.5 ${mobile ? "flex-wrap" : ""}`}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setTypeFilter(f.value)}
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                typeFilter === f.value
                  ? "bg-brand-600 font-medium text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className={`flex flex-1 items-center gap-2 ${mobile ? "flex-col items-stretch" : "justify-end"}`}>
          <div className="relative sm:w-44">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              className="w-full appearance-none rounded-[--radius-control] border border-slate-200 bg-white py-1.5 pl-8 pr-7 text-xs text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              aria-label="操作者筛选"
            >
              {OPERATOR_OPTIONS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 rounded-[--radius-control] border border-slate-200 bg-slate-50 p-0.5">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-[--radius-control] px-2.5 py-1 text-xs transition-colors ${
                  range === r ? "bg-white font-medium text-slate-900 shadow-panel" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 审计记录：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {AUDITS.map((a) => {
            const meta = TYPE_META[a.type];
            const expanded = expandedId === a.id;
            return (
              <li key={a.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
                <button type="button" onClick={() => toggle(a.id)} className="w-full text-left">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{a.action}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-400">{a.resource}</p>
                    </div>
                    <StatusBadge tone={meta.tone}>{meta.text}</StatusBadge>
                  </div>
                  <div className="mt-2 flex items-center gap-2.5 text-[11px] text-slate-400">
                    <Avatar name={a.operator} size="sm" />
                    <span>{a.operator}</span>
                    <span>·</span>
                    <span className="font-mono">{a.time}</span>
                    <span className="ml-auto">
                      <StatusBadge tone={a.result === "success" ? "success" : "danger"} dot={false}>
                        {a.result === "success" ? "成功" : "失败"}
                      </StatusBadge>
                    </span>
                  </div>
                </button>
                {expanded && <ExpandPanel a={a} />}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">时间</th>
                <th className="px-4 py-2.5 font-medium">操作者</th>
                <th className="px-4 py-2.5 font-medium">动作</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">命名空间</th>
                <th className="px-4 py-2.5 font-medium">结果</th>
                <th className="px-4 py-2.5 text-right font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {AUDITS.map((a) => {
                const meta = TYPE_META[a.type];
                const expanded = expandedId === a.id;
                return (
                  <AuditRow key={a.id} a={a} meta={meta} expanded={expanded} onToggle={() => toggle(a.id)} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-center text-[11px] text-slate-400">
        <IconShield className="mx-auto size-3.5" />
        审计日志不可篡改，仅平台管理员可配置保留策略
      </p>
    </div>
  );
}

function AuditRow({
  a,
  meta,
  expanded,
  onToggle,
}: {
  a: AuditRecord;
  meta: { text: string; tone: "brand" | "info" | "warning" | "neutral" };
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`group cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50/60 ${expanded ? "bg-slate-50/80" : ""}`}
      >
        <td className="px-4 py-3 font-mono text-xs text-slate-500">{a.time}</td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center gap-1.5 text-slate-600">
            <Avatar name={a.operator} size="sm" />
            {a.operator}
          </span>
        </td>
        <td className="max-w-md px-4 py-3">
          <p className="font-medium text-slate-900">{a.action}</p>
          <p className="truncate font-mono text-[11px] text-slate-400">{a.resource}</p>
        </td>
        <td className="px-4 py-3">
          <StatusBadge tone={meta.tone}>{meta.text}</StatusBadge>
        </td>
        <td className="px-4 py-3">
          <span className="font-mono text-xs text-slate-600">{a.namespace}</span>
        </td>
        <td className="px-4 py-3">
          <StatusBadge tone={a.result === "success" ? "success" : "danger"} dot={false}>
            {a.result === "success" ? "成功" : "失败"}
          </StatusBadge>
        </td>
        <td className="px-4 py-3 text-right">
          <IconChevronDown
            className={`ml-auto size-4 text-slate-300 transition-transform group-hover:text-slate-500 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-slate-100 bg-slate-50/50">
          <td colSpan={7} className="px-4 py-3">
            <ExpandPanel a={a} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandPanel({ a }: { a: AuditRecord }) {
  return (
    <div className="mt-2 overflow-hidden rounded-[--radius-control] border border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <span className="font-mono text-[10px] text-slate-500">
          {a.id} · {a.operator} · {a.namespace}
        </span>
        <span className="font-mono text-[10px] text-slate-500">immutable</span>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-slate-500">请求</p>
          <pre className="overflow-x-auto rounded-md bg-slate-800/70 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
            {a.req}
          </pre>
        </div>
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-slate-500">响应 / 变更摘要</p>
          <pre className="overflow-x-auto rounded-md bg-slate-800/70 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
            {a.res}
          </pre>
        </div>
      </div>
    </div>
  );
}
