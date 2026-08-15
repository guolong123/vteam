import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconClock,
  IconRefresh,
  StatusBadge,
} from "../_shared/ui";

/**
 * 任务详情页原型（组：任务）
 * =====================================================
 * 顶部：任务名 + 状态 + 按状态操作按钮；
 * 信息条：所属流程 / 触发方式 / 发起人 / 开始时间 / 耗时 / Token；
 * 左栏：执行进度（纵向步骤，运行中脉冲、审批已通过标注）；
 * 右栏：深色 Trace 日志面板（模型/工具调用、token、耗时、报错）；
 * 底部：下一审批关卡提示。
 */

type StepStatus = "done" | "running" | "pending";

interface Step {
  id: string;
  label: string;
  kind: "agent" | "gate" | "system";
  status: StepStatus;
  note: string;
}

const STEPS: Step[] = [
  { id: "s1", label: "需求分析", kind: "agent", status: "done", note: "12 分 08 秒 · 21,420 tok" },
  { id: "s2", label: "需求评审", kind: "gate", status: "done", note: "张三 · 8 分钟前批准" },
  { id: "s3", label: "架构设计", kind: "agent", status: "done", note: "ag-1008 架构师" },
  { id: "s4", label: "测试用例设计", kind: "agent", status: "done", note: "ag-1009 测试工程师" },
  { id: "s5", label: "编码实现", kind: "agent", status: "done", note: "24 分 51 秒 · 86,310 tok" },
  { id: "s6", label: "CI/CD 部署", kind: "system", status: "done", note: "Jenkins build #2145" },
  { id: "s7", label: "测试执行", kind: "agent", status: "running", note: "ag-1003 发布管家 · 64%" },
  { id: "s8", label: "验收归档", kind: "gate", status: "pending", note: "等待 李四 审批" },
];

interface TraceRow {
  time: string;
  tag: "tool" | "model" | "ok" | "info" | "err";
  text: string;
}

const TRACE: TraceRow[] = [
  { time: "10:26:41.082", tag: "info", text: "step=测试执行 agent=ag-1003 发布管家 model=gpt-5.2" },
  { time: "10:26:41.120", tag: "tool", text: "→ tool jenkins.trigger_build { job: \"ketaops-v3.2.1-smoke\", branch: \"release/v3.2.1\" }" },
  { time: "10:26:41.871", tag: "model", text: "→ model gpt-5.2 · prompt 2,180 tok · temperature 0.2" },
  { time: "10:26:45.204", tag: "ok", text: "← model response 1,842 tok · 14.3s" },
  { time: "10:27:02.553", tag: "tool", text: "→ tool github.create_pr { repo: \"ketaops\", title: \"chore: bump v3.2.1\" }" },
  { time: "10:27:04.118", tag: "ok", text: "← ok · pr #3201" },
  { time: "10:27:19.902", tag: "tool", text: "→ tool jenkins.query_status { build: 2145 }" },
  { time: "10:27:20.776", tag: "info", text: "← building · progress 46% · stage: smoke-test" },
  { time: "10:27:33.410", tag: "err", text: "⚠ stage smoke-test · 2 tests failed (io / retry)" },
  { time: "10:27:34.002", tag: "tool", text: "→ tool jenkins.retry { build: 2145, stage: \"smoke-test\" }" },
];

const TRACE_TAG_CLASS: Record<TraceRow["tag"], string> = {
  tool: "text-brand-300",
  model: "text-info-300",
  ok: "text-success-400",
  info: "text-slate-400",
  err: "text-danger-400",
};

const STEP_KIND_ICON: Record<Step["kind"], string> = {
  agent: "A",
  gate: "审",
  system: "S",
};

const STEP_KIND_CLASS: Record<Step["kind"], string> = {
  agent: "bg-brand-50 text-brand-600 ring-brand-500/25",
  gate: "bg-warning-50 text-warning-600 ring-warning-500/25",
  system: "bg-info-50 text-info-600 ring-info-500/25",
};

function StepStatusIcon({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-success-500 text-[10px] font-bold text-white">
        ✓
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="relative flex size-4 items-center justify-center">
        <span className="absolute inline-flex size-4 animate-ping rounded-full bg-brand-400 opacity-60" />
        <span className="relative inline-flex size-2.5 rounded-full bg-brand-500" />
      </span>
    );
  }
  return (
    <span className="flex size-4 items-center justify-center rounded-full border border-slate-200 bg-white">
      <IconClock className="size-3 text-slate-400" />
    </span>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[--radius-card] border border-slate-200 bg-white px-3.5 py-3 shadow-panel">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

export default function TaskDetailPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-lg font-semibold text-slate-900">发布 ketaops v3.2.1</h1>
            <StatusBadge tone="brand">运行中</StatusBadge>
            <span className="font-mono text-xs text-slate-400">tsk-8021</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            软件公司开发流程 v3 · 第 4 个节点「测试执行」正在运行
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            暂停
          </Button>
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            <IconRefresh className="size-3.5" />
            重跑
          </Button>
          <Button variant="danger" className="px-3 py-1.5 text-xs">
            取消
          </Button>
        </div>
      </div>

      {/* 基本信息条 */}
      <div className={`mb-4 grid gap-2.5 ${mobile ? "grid-cols-2" : "grid-cols-6"}`}>
        <InfoItem label="所属流程" value="软件公司开发流程 v3" />
        <InfoItem label="触发方式" value="手动" />
        <InfoItem label="发起人" value="陈曦" />
        <InfoItem label="开始时间" value="今天 10:24" />
        <InfoItem label="耗时" value="4 分 12 秒" />
        <InfoItem label="Token 消耗" value="128,450" />
      </div>

      {/* 主区两栏 */}
      <div className={`grid items-start gap-4 ${mobile ? "grid-cols-1" : "grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"}`}>
        {/* 左：执行进度 */}
        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">执行进度</p>
            <span className="text-xs text-slate-400">8 个节点 · 6 完成</span>
          </div>
          <ol className="p-4">
            {STEPS.map((s, i) => {
              const isLast = i === STEPS.length - 1;
              return (
                <li key={s.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ${STEP_KIND_CLASS[s.kind]}`}
                    >
                      {STEP_KIND_ICON[s.kind]}
                    </span>
                    {!isLast && <span className="w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-4"}`}>
                    <div className="flex items-center gap-2">
                      <p
                        className={`text-[13px] font-medium ${
                          s.status === "pending" ? "text-slate-400" : "text-slate-900"
                        }`}
                      >
                        {s.label}
                      </p>
                      <StepStatusIcon status={s.status} />
                      {s.kind === "gate" && s.status === "done" && (
                        <span className="rounded-full bg-success-50 px-2 py-0.5 text-[10px] font-medium text-success-700 ring-1 ring-inset ring-success-500/20">
                          已审批通过（张三）
                        </span>
                      )}
                      {s.status === "pending" && (
                        <span className="rounded-full bg-warning-50 px-2 py-0.5 text-[10px] font-medium text-warning-700 ring-1 ring-inset ring-warning-500/20">
                          待审批
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{s.note}</p>
                    {s.status === "running" && (
                      <div className="mt-1.5 h-1 w-40 max-w-full overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full w-[64%] animate-pulse rounded-full bg-brand-500" />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* 右：Trace 面板（深色） */}
        <section className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-4 py-2.5">
            <div className="flex items-center gap-1.5">
              <span className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-danger-500/80" />
                <span className="size-2.5 rounded-full bg-warning-500/80" />
                <span className="size-2.5 rounded-full bg-success-500/80" />
              </span>
              <p className="ml-2 font-mono text-xs font-medium text-slate-200">tracing / tsk-8021</p>
            </div>
            <div className="flex items-center gap-1 rounded-md bg-slate-800 p-0.5 text-[11px]">
              {["时间线", "瀑布", "日志"].map((t, idx) => (
                <span
                  key={t}
                  className={`rounded px-2 py-0.5 ${
                    idx === 2 ? "bg-brand-600 font-medium text-white" : "text-slate-400"
                  }`}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-0.5 bg-slate-900 px-4 py-3 font-mono text-[11px] leading-relaxed">
            {TRACE.map((r, i) => (
              <p key={i} className={`flex gap-2 ${r.tag === "err" ? "rounded bg-danger-500/10 px-1 -mx-1" : ""}`}>
                <span className="shrink-0 text-slate-500">{r.time}</span>
                <span className={TRACE_TAG_CLASS[r.tag]}>{r.text}</span>
              </p>
            ))}
            <p className="flex gap-2 text-slate-500">
              <span className="shrink-0">10:27:34.810</span>
              <span className="animate-pulse text-brand-300">▍</span>
              <span className="text-brand-300/70">等待模型响应…</span>
            </p>
          </div>
          <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900 px-4 py-2">
            <p className="font-mono text-[11px] text-slate-500">span 12 / 214 · 当前节点耗时 53s</p>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="size-1.5 animate-pulse rounded-full bg-success-500" />
              自动刷新
            </span>
          </div>
        </section>
      </div>

      {/* 底部：下一审批关卡提示 */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[--radius-card] border border-warning-200 bg-warning-50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning-100 text-warning-600">
            <IconClock className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-warning-800">
              等待 李四 审批：需求文档评审
            </p>
            <p className="truncate text-xs text-warning-700/80">
              关卡「验收归档」· 已超时 1 小时，超时将自动升级通知研发总监
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            催办
          </Button>
          <Button className="px-3 py-1.5 text-xs">查看审批详情</Button>
        </div>
      </div>

      {/* 审批人卡片 */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <Avatar name="李四" size="sm" />
        <span>审批人：李四（研发总监）</span>
        <span>·</span>
        <span>已关联待办 #ap-305</span>
      </div>
    </div>
  );
}
