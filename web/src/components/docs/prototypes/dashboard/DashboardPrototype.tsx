import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconClock,
  IconMore,
  ProgressBar,
  StatusBadge,
  type Tone,
} from "../_shared/ui";

/**
 * 平台仪表盘原型（组：总览，首页）
 * =====================================================
 * 顶部欢迎行（环境信息）+ 统计卡片 + 运行中任务 / 待审批双栏
 * + 底部系统健康与命名空间任务分布。纯 UI 原型。
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

const IconEye = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

const IconServer = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="20" height="8" x="2" y="2" rx="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" />
    <path d="M6 6h.01M6 18h.01" />
  </Icon>
);

const IconActivity = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Icon>
);

const IconLayers = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m12 2 10 6.5-10 6.5L2 8.5 12 2Z" />
    <path d="m2 12.5 10 6.5 10-6.5" />
    <path d="m2 17 10 6.5L22 17" />
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
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
  </Icon>
);

/* ---------- 数据 ---------- */

interface StatCardData {
  label: string;
  value: string;
  trend: string;
  trendUp: boolean;
  accent: string;
  icon: ReactNode;
}

const STATS: StatCardData[] = [
  { label: "总任务数", value: "1,286", trend: "+12.4% 较上周", trendUp: true, accent: "bg-brand-500", icon: <IconLayers className="size-4" /> },
  { label: "运行中任务", value: "8", trend: "2 个等待审批", trendUp: false, accent: "bg-info-500", icon: <IconActivity className="size-4" /> },
  { label: "待审批数", value: "6", trend: "-2 较昨日", trendUp: true, accent: "bg-warning-500", icon: <IconShield className="size-4" /> },
  { label: "今日 Token 消耗", value: "2.4M", trend: "+18.2% 较昨日", trendUp: false, accent: "bg-success-500", icon: <IconBox className="size-4" /> },
];

interface RunningTask {
  id: string;
  name: string;
  flow: string;
  progress: number;
  owner: string;
  startedAt: string;
}

const RUNNING_TASKS: RunningTask[] = [
  { id: "tsk-8025", name: "客户门户改版-测试执行", flow: "软件公司开发流程 v3", progress: 41, owner: "王五", startedAt: "10:41" },
  { id: "tsk-8021", name: "发布 ketaops v3.2.1", flow: "发布流水线 v4", progress: 64, owner: "陈曦", startedAt: "10:24" },
  { id: "tsk-8020", name: "全量回归测试 · 核心模块", flow: "回归测试流水线", progress: 28, owner: "林远", startedAt: "10:18" },
  { id: "tsk-8023", name: "生产证书续期预检", flow: "证书续期流程", progress: 12, owner: "赵磊", startedAt: "09:52" },
];

interface PendingApproval {
  id: string;
  title: string;
  type: string;
  typeTone: Tone;
  submitter: string;
  time: string;
}

const PENDING_APPROVALS: PendingApproval[] = [
  { id: "ap-305", title: "需求文档评审：客户门户改版", type: "需求评审", typeTone: "warning", submitter: "王五", time: "12 分钟前" },
  { id: "ap-301", title: "申请创建「发布管家」Agent", type: "创建 Agent", typeTone: "info", submitter: "赵磊", time: "1 小时前" },
  { id: "ap-302", title: "生产环境证书续期任务发布", type: "任务发布", typeTone: "brand", submitter: "王倩", time: "2 小时前" },
  { id: "ap-303", title: "日志分析员授予「写」权限", type: "权限变更", typeTone: "warning", submitter: "陈曦", time: "3 小时前" },
];

const NS_DISTRIBUTION = [
  { name: "default", percent: 48, tone: "bg-brand-500" },
  { name: "dev-team", percent: 22, tone: "bg-info-500" },
  { name: "test-team", percent: 18, tone: "bg-warning-500" },
  { name: "ops", percent: 12, tone: "bg-success-500" },
] as const;

/* ---------- 组件 ---------- */

export default function DashboardPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 欢迎行 + 环境信息 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">平台总览</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            所有编排流水线的运行状态一目了然
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 shadow-panel">
            <span className="size-1.5 rounded-full bg-brand-500" />
            命名空间 default
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 shadow-panel">
            <IconServer className="size-3.5 text-slate-400" />
            opencode serve
          </span>
          <StatusBadge tone="success">已连接</StatusBadge>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className={`mb-4 grid gap-3 ${mobile ? "grid-cols-2" : "grid-cols-2 xl:grid-cols-4"}`}>
        {STATS.map((s) => (
          <div
            key={s.label}
            className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className={`flex size-8 items-center justify-center rounded-[--radius-control] bg-slate-50 text-slate-500 ring-1 ring-slate-200`}>
                {s.icon}
              </div>
              <span className={`h-1 w-6 rounded-full ${s.accent}`} />
            </div>
            <p className="text-2xl font-semibold tracking-tight text-slate-900">{s.value}</p>
            <p className="mt-0.5 text-xs text-slate-500">{s.label}</p>
            <p
              className={`mt-1 text-[11px] font-medium ${
                s.trendUp ? "text-success-600" : "text-slate-400"
              }`}
            >
              {s.trend}
            </p>
          </div>
        ))}
      </div>

      {/* 中部两栏：运行中任务 / 待审批 */}
      <div className={`mb-4 grid items-start gap-4 ${mobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {/* 运行中任务 */}
        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">运行中任务</p>
            <span className="rounded-full bg-info-50 px-2 py-0.5 text-xs font-medium text-info-700 ring-1 ring-inset ring-info-500/20">
              {RUNNING_TASKS.length} 个
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {RUNNING_TASKS.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <span className="relative flex size-2.5 shrink-0 items-center justify-center">
                  <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-brand-400 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[13px] font-medium text-slate-900">{t.name}</p>
                    <span className="shrink-0 font-mono text-[11px] text-slate-400">{t.progress}%</span>
                  </div>
                  <p className="truncate text-[11px] text-slate-400">
                    {t.flow} · 提交人 {t.owner} · {t.startedAt}
                  </p>
                  <div className="mt-1.5">
                    <ProgressBar value={t.progress} tone="brand" />
                  </div>
                </div>
                <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs">
                  <IconEye className="size-3.5" />
                  查看
                </Button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-100 px-4 py-2">
            <Button variant="ghost" className="w-full px-2 py-1.5 text-xs text-brand-600 hover:bg-brand-50">
              查看全部任务
            </Button>
          </div>
        </section>

        {/* 待审批 */}
        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">待审批</p>
            <span className="rounded-full bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-700 ring-1 ring-inset ring-warning-500/25">
              {PENDING_APPROVALS.length} 条待处理
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {PENDING_APPROVALS.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[13px] font-medium text-slate-900">{a.title}</p>
                    <StatusBadge tone={a.typeTone} dot={false}>
                      {a.type}
                    </StatusBadge>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <Avatar name={a.submitter} size="sm" />
                    {a.submitter}
                    <span className="inline-flex items-center gap-1">
                      <IconClock className="size-3" />
                      {a.time}
                    </span>
                  </p>
                </div>
                <Button className="shrink-0 px-3 py-1.5 text-xs">去审批</Button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-100 px-4 py-2">
            <Button variant="ghost" className="w-full px-2 py-1.5 text-xs text-brand-600 hover:bg-brand-50">
              进入审批中心
            </Button>
          </div>
        </section>
      </div>

      {/* 底部：系统健康 + 命名空间分布 */}
      <div className={`grid items-start gap-4 ${mobile ? "grid-cols-1" : "grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"}`}>
        {/* 系统健康 */}
        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">系统健康</p>
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
              <span className="size-1.5 animate-pulse rounded-full bg-success-500" />
              实时
            </span>
          </div>
          <div className={`grid gap-px bg-slate-100 ${mobile ? "grid-cols-1" : "grid-cols-2"}`}>
            <HealthItem
              label="opencode serve 连接"
              value="已连接 · 延迟 12ms"
              tone="success"
              icon={<IconServer className="size-4" />}
            />
            <HealthItem
              label="Worker 节点"
              value="12 个运行中 · 2 空闲"
              tone="brand"
              icon={<IconActivity className="size-4" />}
            />
            <HealthItem
              label="最近一次错误"
              value="昨天 18:42 · 已自动恢复"
              tone="warning"
              icon={<IconClock className="size-4" />}
            />
            <HealthItem
              label="累计执行任务"
              value="1,286 · 成功率 98.2%"
              tone="success"
              icon={<IconBox className="size-4" />}
            />
          </div>
        </section>

        {/* 命名空间任务分布 */}
        <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">按命名空间任务分布</p>
            <button type="button" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="更多">
              <IconMore className="size-4" />
            </button>
          </div>
          <ul className="space-y-3.5 px-4 py-4">
            {NS_DISTRIBUTION.map((ns) => (
              <li key={ns.name}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-mono text-slate-600">{ns.name}</span>
                  <span className="font-medium text-slate-900">{ns.percent}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${ns.tone}`} style={{ width: `${ns.percent}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
            近 30 天 · 各命名空间下的任务占比
          </p>
        </section>
      </div>
    </div>
  );
}

function HealthItem({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "brand";
  icon: ReactNode;
}) {
  const iconClass =
    tone === "success"
      ? "bg-success-50 text-success-600"
      : tone === "warning"
        ? "bg-warning-50 text-warning-600"
        : "bg-brand-50 text-brand-600";
  return (
    <div className="flex items-center gap-3 bg-white px-4 py-3.5">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] ${iconClass}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-slate-400">{label}</p>
        <p className="truncate text-[13px] font-medium text-slate-800">{value}</p>
      </div>
    </div>
  );
}
