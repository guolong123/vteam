import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, StatusBadge } from "../_shared/ui";

/**
 * 任务 Trace 全览原型（组：任务，task-detail 之后）
 * =====================================================
 * 顶部任务信息 + 筛选行（类型 / Agent / 时间范围）；
 * 主区：纵向时间线 trace，类型色点（模型=brand、工具=info、
 * 审批=warning、错误=danger）+ 时间戳 + 内容 + 状态；
 * 点击步骤行展开深色请求/响应摘要面板。纯 UI 交互。
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

const IconChevronDown = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

const IconFilter = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </Icon>
);

const IconClock = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

/* ---------- 数据 ---------- */

type TraceType = "model" | "tool" | "approval" | "error" | "system";
type TraceStatus = "success" | "failed" | "running";

interface TraceStep {
  id: string;
  type: TraceType;
  time: string;
  label: string;
  detail: string;
  status: TraceStatus;
  req: string;
  res: string;
}

const TRACE: TraceStep[] = [
  {
    id: "tr-01",
    type: "model",
    time: "10:41:02.118",
    label: "调用模型 deepseek-v3 · 规划测试执行策略",
    detail: "输入 1.2k tokens，输出 340 tokens，耗时 4.2s",
    status: "success",
    req: 'POST /v1/chat/completions\nmodel: "deepseek-v3"\nmessages: [\n  { role: "system", content: "你是测试工程师…" },\n  { role: "user", content: "针对 PR #3256 规划 smoke 测试策略" },\n]\ntemperature: 0.2',
    res: '200 OK · 4.2s\nchoices[0].message.content:\n"1. 执行 portal-smoke 构建\n2. 校验 24 条核心用例\n3. 失败自动重试 1 次…"\nusage: { prompt_tokens: 1200, completion_tokens: 340 }',
  },
  {
    id: "tr-02",
    type: "tool",
    time: "10:41:06.512",
    label: "工具调用 github_get_pr_files",
    detail: '参数 { repo: "ketaops-portal", pr: 3256 }',
    status: "success",
    req: "github.get_pr_files\n{ repo: \"ketaops-portal\", pr: 3256 }",
    res: "200 OK · 1.1s\nfiles: [\n  \"src/pages/Login.tsx\",\n  \"src/utils/export.ts\",\n  \"tests/smoke/login.spec.ts\"\n]",
  },
  {
    id: "tr-03",
    type: "model",
    time: "10:41:10.230",
    label: "调用模型 deepseek-v3 · 生成测试用例",
    detail: "输入 2.1k tokens，输出 1.4k tokens，耗时 6.8s",
    status: "success",
    req: 'messages: [{ role: "user", content: "基于变更文件生成 24 条用例" }]',
    res: "200 OK · 6.8s\n生成 24 条用例，覆盖登录 / 导出 / 布局三组",
  },
  {
    id: "tr-04",
    type: "tool",
    time: "10:41:17.905",
    label: "工具调用 jenkins_trigger_build",
    detail: '参数 { job: "portal-smoke", branch: "release/portal-v2" }',
    status: "success",
    req: "jenkins.trigger_build\n{ job: \"portal-smoke\", branch: \"release/portal-v2\" }",
    res: "201 Created · 0.8s\nbuild: 3182 · queue: 4",
  },
  {
    id: "tr-05",
    type: "error",
    time: "10:41:25.441",
    label: "工具调用 jenkins_query_status 失败",
    detail: '参数 { build: 3182 } · 构建队列超时（queue_timeout）',
    status: "failed",
    req: "jenkins.query_status\n{ build: 3182 }",
    res: "502 Bad Gateway · 30s\nerror: \"build queue timeout after 30s\"",
  },
  {
    id: "tr-06",
    type: "tool",
    time: "10:41:26.004",
    label: "工具调用 jenkins_retry · 自动重试",
    detail: '参数 { build: 3182, reason: "queue-timeout" }',
    status: "success",
    req: "jenkins.retry\n{ build: 3182, reason: \"queue-timeout\" }",
    res: "200 OK · 0.6s\nretried · build: 3182 · stage: smoke-test",
  },
  {
    id: "tr-07",
    type: "model",
    time: "10:41:38.872",
    label: "调用模型 deepseek-v3 · 分析失败用例",
    detail: "输入 3.5k tokens，输出 620 tokens，耗时 9.1s",
    status: "success",
    req: "messages: [ 2 tests failed (io / retry)，定位根因 ]",
    res: "200 OK · 9.1s\n根因：登录态 token 刷新竞态，见 issue 建议",
  },
  {
    id: "tr-08",
    type: "approval",
    time: "10:42:10.330",
    label: "审批检查点「测试执行评审」已触发",
    detail: "等待 李四（研发总监）人工审批 · 关联 ap-306",
    status: "running",
    req: "approval.create\n{ checkpoint: \"测试执行评审\", assignee: \"李四\" }",
    res: "201 Created · 0.2s\napproval: ap-306 · status: pending\nTTL: 24h · 超时升级通知研发总监",
  },
  {
    id: "tr-09",
    type: "model",
    time: "10:42:14.556",
    label: "调用模型 deepseek-v3 · 生成缺陷修复建议",
    detail: "输入 0.9k tokens，输出 0.5k tokens，耗时 3.1s",
    status: "success",
    req: "messages: [ 为 io / retry 两个失败用例给出修复建议 ]",
    res: "200 OK · 3.1s\n输出 2 条修复建议，附代码片段",
  },
  {
    id: "tr-10",
    type: "tool",
    time: "10:42:18.093",
    label: "工具调用 github_create_issue",
    detail: '参数 { repo: "ketaops-portal", title: "登录页 token 刷新竞态缺陷" }',
    status: "success",
    req: "github.create_issue\n{ repo: \"ketaops-portal\", title: \"登录页 token 刷新竞态缺陷\", labels: [\"bug\"] }",
    res: "201 Created · 0.9s\nissue: #3271",
  },
  {
    id: "tr-11",
    type: "tool",
    time: "10:42:21.770",
    label: "工具调用 github_create_issue",
    detail: '参数 { repo: "ketaops-portal", title: "导出 CSV 中文乱码" }',
    status: "success",
    req: "github.create_issue\n{ repo: \"ketaops-portal\", title: \"导出 CSV 中文乱码\" }",
    res: "201 Created · 0.8s\nissue: #3272",
  },
  {
    id: "tr-12",
    type: "model",
    time: "10:42:27.314",
    label: "调用模型 deepseek-v3 · 汇总测试报告",
    detail: "输入 2.8k tokens，输出 1.1k tokens，耗时 7.4s",
    status: "success",
    req: "messages: [ 生成测试执行总结报告 ]",
    res: "200 OK · 7.4s\n报告已生成：24 用例，2 失败已建 issue，待审批后归档",
  },
  {
    id: "tr-13",
    type: "tool",
    time: "10:42:30.021",
    label: "工具调用 wecom_send_message",
    detail: '参数 { channel: "release-ops", text: "smoke 已通过" }',
    status: "success",
    req: "wecom.send_message\n{ channel: \"release-ops\", text: \"客户门户 smoke 已通过，等待验收审批\" }",
    res: "200 OK · 0.4s\nmessage_id: 8f3a2c91",
  },
  {
    id: "tr-14",
    type: "system",
    time: "10:42:31.660",
    label: "流程等待审批节点继续",
    detail: "已暂停于「测试执行评审」，通过后进入「验收归档」",
    status: "running",
    req: "flow.await_gate\n{ checkpoint: \"测试执行评审\" }",
    res: "pending · 等待人工审批后继续",
  },
];

const TYPE_META: Record<TraceType, { text: string; dot: string; ring: string }> = {
  model: { text: "模型调用", dot: "bg-brand-500", ring: "ring-brand-500/25" },
  tool: { text: "工具调用", dot: "bg-info-500", ring: "ring-info-500/20" },
  approval: { text: "审批", dot: "bg-warning-500", ring: "ring-warning-500/25" },
  error: { text: "错误", dot: "bg-danger-500", ring: "ring-danger-500/20" },
  system: { text: "系统", dot: "bg-slate-400", ring: "ring-slate-500/15" },
};

const TYPE_FILTERS: Array<{ value: "all" | TraceType; label: string }> = [
  { value: "all", label: "全部" },
  { value: "model", label: "模型调用" },
  { value: "tool", label: "工具调用" },
  { value: "approval", label: "审批" },
  { value: "error", label: "错误" },
];

const AGENT_OPTIONS = ["全部 Agent", "ag-1003 发布管家", "ag-1001 需求分析 Agent", "ag-1009 测试工程师"];
const RANGE_OPTIONS = ["全部时间", "今天", "过去 7 天", "过去 30 天"];

/* ---------- 组件 ---------- */

export default function TaskTracePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [typeFilter, setTypeFilter] = useState<"all" | TraceType>("all");
  const [agentFilter, setAgentFilter] = useState(AGENT_OPTIONS[0]);
  const [range, setRange] = useState(RANGE_OPTIONS[0]);
  const [expandedId, setExpandedId] = useState<string | null>("tr-08");

  const toggle = (id: string) => setExpandedId((prev) => (prev === id ? null : id));

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-lg font-semibold text-slate-900">客户门户改版-测试执行</h1>
          <StatusBadge tone="brand">运行中</StatusBadge>
          <span className="font-mono text-xs text-slate-400">tsk-8025</span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          软件公司开发流程 v3 · 第 6 个节点「测试执行」· Agent ag-1003 发布管家
        </p>
      </div>

      {/* 基本信息条 */}
      <div className={`mb-4 grid gap-2.5 ${mobile ? "grid-cols-2" : "grid-cols-4"}`}>
        <InfoItem label="所属流程" value="软件公司开发流程 v3" />
        <InfoItem label="触发方式" value="手动 · 10:41" />
        <InfoItem label="耗时" value="4 分 18 秒" />
        <InfoItem label="Token 累计" value="24,680" />
      </div>

      {/* 筛选行 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "flex-wrap items-center"}`}>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <IconFilter className="size-3.5" />
          筛选
        </span>
        <div className={`flex gap-1.5 ${mobile ? "flex-wrap" : ""}`}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setTypeFilter(f.value)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                typeFilter === f.value
                  ? "bg-brand-600 font-medium text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className={`flex flex-1 gap-2 ${mobile ? "flex-col" : "justify-end"}`}>
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-[--radius-control] border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            aria-label="Agent 筛选"
          >
            {AGENT_OPTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded-[--radius-control] border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            aria-label="时间范围"
          >
            {RANGE_OPTIONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Trace 时间线 */}
      <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <p className="text-sm font-semibold text-slate-900">Trace 时间线</p>
          <span className="text-xs text-slate-400">14 个 span · 当前节点耗时 4 分 18 秒</span>
        </div>
        <ol className="px-4 py-3 sm:px-5">
          {TRACE.map((step, i) => {
            const isLast = i === TRACE.length - 1;
            const meta = TYPE_META[step.type];
            const expanded = expandedId === step.id;
            return (
              <li key={step.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${meta.dot}`} />
                  {!isLast && <span className="w-px flex-1 bg-slate-200" />}
                </div>
                <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-2.5"}`}>
                  <button
                    type="button"
                    onClick={() => toggle(step.id)}
                    className="group flex w-full items-start gap-2 rounded-[--radius-control] px-2 py-1.5 text-left hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1`}>
                        <span className="font-mono text-[11px] text-slate-400">{step.time}</span>
                        <span
                          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${meta.ring}`}
                        >
                          {meta.text}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[13px] font-medium text-slate-900">{step.label}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{step.detail}</p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <StepStatus status={step.status} />
                      <IconChevronDown
                        className={`size-3.5 text-slate-300 transition-transform group-hover:text-slate-500 ${
                          expanded ? "rotate-180" : ""
                        }`}
                      />
                    </span>
                  </button>

                  {/* 展开详情面板（深色代码区） */}
                  {expanded && (
                    <div className="mt-1.5 overflow-hidden rounded-[--radius-control] border border-slate-700 bg-slate-900">
                      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
                        <span className="flex gap-1.5">
                          <span className="size-2 rounded-full bg-danger-500/80" />
                          <span className="size-2 rounded-full bg-warning-500/80" />
                          <span className="size-2 rounded-full bg-success-500/80" />
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">span {step.id}</span>
                      </div>
                      <div className="grid gap-3 p-3 sm:grid-cols-2">
                        <CodeBlock label="请求" text={step.req} />
                        <CodeBlock label="响应" text={step.res} />
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2">
          <p className="font-mono text-[11px] text-slate-400">span 14 / 214 · 任务 trace-id 9f2c-8a71</p>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="size-1.5 animate-pulse rounded-full bg-success-500" />
            实时追踪中
          </span>
        </div>
      </section>

      {/* 操作提示 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <p className="inline-flex items-center gap-1.5">
          <IconClock className="size-3.5" />
          已捕获 1 次工具失败并自动重试 · 1 个审批检查点等待人工确认
        </p>
        <Button variant="outline" className="px-3 py-1.5 text-xs">
          导出 Trace
        </Button>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[--radius-card] border border-slate-200 bg-white px-3.5 py-3 shadow-panel">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

function StepStatus({ status }: { status: TraceStatus }) {
  if (status === "success") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-success-500 text-[10px] font-bold text-white">
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-danger-500 text-[10px] font-bold text-white">
        ✗
      </span>
    );
  }
  return (
    <span className="relative flex size-5 items-center justify-center">
      <span className="absolute inline-flex size-5 animate-ping rounded-full bg-brand-400 opacity-50" />
      <span className="relative inline-flex size-2.5 rounded-full bg-brand-500" />
    </span>
  );
}

function CodeBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-slate-800/70 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
        {text}
      </pre>
    </div>
  );
}
