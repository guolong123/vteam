import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconEdit,
  IconMore,
  StatusBadge,
  type Tone,
} from "../_shared/ui";

/**
 * 流程详情页原型（组：编排，flow-list 之后）
 * =====================================================
 * 顶部流程信息 + 操作；Tab 切换：概览 / 版本历史 / 执行记录。
 * 纯 UI 交互，无真实数据逻辑。
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

const IconPlay = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </Icon>
);

const IconStop = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="14" height="14" x="5" y="5" rx="2" />
  </Icon>
);

const IconClock = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

const IconGitBranch = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M6 9v6M18 9a4 4 0 0 1-4 4H9" />
    <circle cx="18" cy="6" r="3" />
  </Icon>
);

const IconWebhook = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M8 13a4 4 0 1 1 4-4" />
    <path d="M8 13a3 3 0 1 0 3 3" />
    <path d="M8 13h8" />
    <path d="M16 13a3 3 0 1 0 3 3" />
    <circle cx="6" cy="18" r="2" />
  </Icon>
);

const IconDiff = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
);

const IconSearch = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
);

/* ---------- 数据 ---------- */

type TabKey = "overview" | "versions" | "executions";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "versions", label: "版本历史" },
  { key: "executions", label: "执行记录" },
];

interface FlowNode {
  name: string;
  kind: "agent" | "gate";
  note: string;
}

const NODES: FlowNode[] = [
  { name: "需求分析", kind: "agent", note: "ag-1001 需求分析 Agent · 输出需求文档" },
  { name: "需求评审", kind: "gate", note: "审批人：李四（研发总监）" },
  { name: "架构设计", kind: "agent", note: "ag-1008 架构师 · 输出架构方案" },
  { name: "测试用例设计", kind: "agent", note: "ag-1009 测试工程师 · 输出用例集" },
  { name: "编码实现", kind: "agent", note: "ag-1010 开发工程师 · 关联 GitHub PR" },
  { name: "测试执行", kind: "agent", note: "ag-1003 发布管家 · 触发 Jenkins" },
  { name: "验收归档", kind: "gate", note: "审批人：李四 / 陈曦" },
];

const TRIGGERS: Array<{ label: string; icon: ReactNode; tone: Tone }> = [
  { label: "手动触发", icon: <IconPlay className="size-3.5" />, tone: "brand" },
  { label: "定时触发 · 每天 10:00", icon: <IconClock className="size-3.5" />, tone: "info" },
  { label: "Webhook · GitHub push", icon: <IconWebhook className="size-3.5" />, tone: "neutral" },
];

interface FlowVersion {
  version: number;
  status: "published" | "draft";
  date: string;
  author: string;
  note: string;
}

const VERSIONS: FlowVersion[] = [
  { version: 3, status: "published", date: "2026-07-20", author: "王五", note: "增加「验收归档」审批关卡，编码实现后强制人工验收" },
  { version: 2, status: "published", date: "2026-06-28", author: "陈曦", note: "调整「测试用例设计」与「编码实现」为并行分支" },
  { version: 1, status: "draft", date: "2026-06-02", author: "陈曦", note: "初版：需求分析 → 编码实现 → 测试执行" },
];

interface ExecutionRecord {
  id: string;
  name: string;
  status: "running" | "success" | "failed" | "pending";
  trigger: string;
  time: string;
  duration: string;
}

const EXECUTIONS: ExecutionRecord[] = [
  { id: "tsk-8025", name: "客户门户改版-测试执行", status: "running", trigger: "手动", time: "今天 10:41", duration: "进行中" },
  { id: "tsk-8018", name: "客户门户改版-编码实现", status: "success", trigger: "手动", time: "昨天 15:02", duration: "24 分 51 秒" },
  { id: "tsk-8012", name: "客户门户改版-测试执行", status: "failed", trigger: "定时", time: "07-18 10:00", duration: "18 分 07 秒" },
  { id: "tsk-8005", name: "客户门户改版-需求分析", status: "success", trigger: "Webhook", time: "07-16 09:31", duration: "12 分 08 秒" },
];

const STATUS_META: Record<ExecutionRecord["status"], { text: string; tone: Tone }> = {
  running: { text: "运行中", tone: "brand" },
  success: { text: "成功", tone: "success" },
  failed: { text: "失败", tone: "danger" },
  pending: { text: "等待审批", tone: "warning" },
};

/* ---------- 组件 ---------- */

export default function FlowDetailPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-lg font-semibold text-slate-900">软件公司开发流程</h1>
            <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-500/25">
              v3
            </span>
            <StatusBadge tone="success">已发布</StatusBadge>
            <span className="font-mono text-xs text-slate-400">flw-001</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            9 个节点 · 3 个审批关卡 · 更新于 5 分钟前（王五）
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            <IconEdit className="size-3.5" />
            编辑画布
          </Button>
          <Button className="px-3 py-1.5 text-xs">
            <IconGitBranch className="size-3.5" />
            发布新版本
          </Button>
          <Button variant="outline" className="px-3 py-1.5 text-xs">
            <IconStop className="size-3.5" />
            停用
          </Button>
        </div>
      </div>

      {/* Tab 栏 */}
      <div className="mb-4 flex items-center gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3.5 py-2 text-sm transition-colors ${
              tab === t.key
                ? "border-brand-600 font-medium text-brand-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab mobile={mobile} />}
      {tab === "versions" && <VersionsTab mobile={mobile} />}
      {tab === "executions" && <ExecutionsTab mobile={mobile} />}
    </div>
  );
}

/* ---------- 概览 Tab ---------- */

function OverviewTab({ mobile }: { mobile: boolean }) {
  return (
    <div className={`grid items-start gap-4 ${mobile ? "grid-cols-1" : "grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"}`}>
      {/* 左：描述 + 节点清单 */}
      <div className="space-y-4">
        <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">流程描述</h2>
          <p className="text-[13px] leading-relaxed text-slate-600">
            面向软件研发团队的标准化交付流水线：从需求分析出发，经需求评审、架构设计、测试用例设计，
            以并行分支完成编码实现与测试执行，最终由人工验收归档后交付上线。
          </p>
        </section>

        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">节点清单</p>
            <span className="text-xs text-slate-400">7 个节点 · 5 Agent + 2 审批 Gate</span>
          </div>
          <ol className="p-4">
            {NODES.map((n, i) => {
              const isLast = i === NODES.length - 1;
              return (
                <li key={n.name} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ring-1 ${
                        n.kind === "agent"
                          ? "bg-brand-50 text-brand-600 ring-brand-500/25"
                          : "bg-warning-50 text-warning-600 ring-warning-500/25"
                      }`}
                    >
                      {n.kind === "agent" ? "A" : "审"}
                    </span>
                    {!isLast && <span className="w-px flex-1 bg-slate-200" />}
                  </div>
                  <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-4"}`}>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-slate-900">{n.name}</p>
                      {n.kind === "gate" && (
                        <span className="rounded-full bg-warning-50 px-2 py-0.5 text-[10px] font-medium text-warning-700 ring-1 ring-inset ring-warning-500/25">
                          审批关卡
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{n.note}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      {/* 右：触发方式 + 命名空间 */}
      <div className="space-y-4">
        <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <h2 className="mb-2.5 text-sm font-semibold text-slate-900">触发方式</h2>
          <div className="flex flex-wrap gap-2">
            {TRIGGERS.map((t) => (
              <span
                key={t.label}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                  t.tone === "brand"
                    ? "bg-brand-50 text-brand-700 ring-brand-500/25"
                    : t.tone === "info"
                      ? "bg-info-50 text-info-700 ring-info-500/20"
                      : "bg-slate-100 text-slate-600 ring-slate-500/15"
                }`}
              >
                {t.icon}
                {t.label}
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <h2 className="mb-2.5 text-sm font-semibold text-slate-900">所属命名空间</h2>
          <p className="font-mono text-[13px] text-slate-700">default</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            该流程可被命名空间下所有 Agent 引用
          </p>
        </section>

        <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <h2 className="mb-2.5 text-sm font-semibold text-slate-900">运行统计</h2>
          <dl className="space-y-2 text-[13px]">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">累计执行</dt>
              <dd className="font-medium text-slate-900">46 次</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">平均耗时</dt>
              <dd className="font-medium text-slate-900">58 分 20 秒</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">成功率</dt>
              <dd className="font-medium text-success-600">93.5%</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

/* ---------- 版本历史 Tab ---------- */

function VersionsTab({ mobile }: { mobile: boolean }) {
  if (mobile) {
    return (
      <ul className="space-y-3">
        {VERSIONS.map((v) => (
          <li key={v.version} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-500/25">
                v{v.version}
              </span>
              <StatusBadge tone={v.status === "published" ? "success" : "warning"}>
                {v.status === "published" ? "已发布" : "草稿"}
              </StatusBadge>
            </div>
            <p className="mb-2 text-[13px] leading-relaxed text-slate-600">{v.note}</p>
            <p className="mb-3 flex items-center gap-1.5 text-xs text-slate-400">
              <Avatar name={v.author} size="sm" />
              {v.author} · {v.date}
            </p>
            <Button variant="outline" className="w-full px-2 py-1.5 text-xs">
              <IconDiff className="size-3.5" />
              查看差异
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            <th className="px-4 py-2.5 font-medium">版本</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 font-medium">变更说明</th>
            <th className="px-4 py-2.5 font-medium">更新人</th>
            <th className="px-4 py-2.5 font-medium">发布时间</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {VERSIONS.map((v) => (
            <tr key={v.version} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-500/25">
                  v{v.version}
                </span>
              </td>
              <td className="px-4 py-3">
                <StatusBadge tone={v.status === "published" ? "success" : "warning"}>
                  {v.status === "published" ? "已发布" : "草稿"}
                </StatusBadge>
              </td>
              <td className="max-w-md px-4 py-3 text-slate-600">{v.note}</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <Avatar name={v.author} size="sm" />
                  {v.author}
                </span>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-500">{v.date}</td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" className="px-2 py-1 text-xs">
                    <IconDiff className="size-3.5" />
                    查看差异
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs">
                    查看画布
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 执行记录 Tab ---------- */

function ExecutionsTab({ mobile }: { mobile: boolean }) {
  const header = (
    <div className="mb-4 flex items-center gap-2 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel">
      <div className="relative w-full sm:w-72">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="搜索执行记录…"
          className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
      </div>
      <button type="button" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="更多">
        <IconMore className="size-4" />
      </button>
    </div>
  );

  if (mobile) {
    return (
      <>
        {header}
        <ul className="space-y-3">
          {EXECUTIONS.map((e) => (
            <li key={e.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-slate-900">{e.name}</p>
                <StatusBadge tone={STATUS_META[e.status].tone}>{STATUS_META[e.status].text}</StatusBadge>
              </div>
              <p className="font-mono text-[11px] text-slate-400">{e.id}</p>
              <dl className="mt-2 space-y-1.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                <div className="flex justify-between">
                  <dt>触发</dt>
                  <dd className="text-slate-700">{e.trigger} · {e.time}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>耗时</dt>
                  <dd className="font-mono text-slate-700">{e.duration}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-4 py-2.5 font-medium">任务</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">触发</th>
              <th className="px-4 py-2.5 font-medium">时间</th>
              <th className="px-4 py-2.5 font-medium">耗时</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {EXECUTIONS.map((e) => (
              <tr key={e.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{e.name}</p>
                  <p className="font-mono text-[11px] text-slate-400">{e.id}</p>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge tone={STATUS_META[e.status].tone}>{STATUS_META[e.status].text}</StatusBadge>
                </td>
                <td className="px-4 py-3 text-slate-600">{e.trigger}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{e.time}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{e.duration}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" className="px-2 py-1 text-xs">详情</Button>
                    <button type="button" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="更多">
                      <IconMore className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
