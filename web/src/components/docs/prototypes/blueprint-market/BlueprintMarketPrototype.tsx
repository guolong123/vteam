import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconSearch, StatusBadge } from "../_shared/ui";

/**
 * 业务蓝图市场原型（组：生态，plugin-market 之前）
 * =====================================================
 * 蓝图（业务包）卡片网格 + 搜索 / 分类 pills；
 * 点击「安装」弹出确认弹窗（选择命名空间，展示将创建的资源清单）。
 * 纯 UI 交互，无真实安装逻辑。
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

const IconPackage = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
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

const IconGate = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 3v18" />
    <path d="M5 21h14" />
    <path d="M5 21 3 7l9-4 9 4-2 14" />
  </Icon>
);

const IconX = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

/* ---------- 数据 ---------- */

type BlueprintCategory = "flow" | "tool" | "custom";

interface Blueprint {
  id: string;
  name: string;
  icon: string;
  version: string;
  desc: string;
  category: BlueprintCategory;
  agents: number;
  flows: number;
  gates: number;
  scenarios: string[];
  installed: boolean;
  hot?: boolean;
}

const BLUEPRINTS: Blueprint[] = [
  {
    id: "bpt-software-dev",
    name: "软件公司开发流程",
    icon: "🧑‍💻",
    version: "v3.2.0",
    desc: "标准研发交付流水线：需求分析 → 架构设计 → 编码实现 → 测试执行，人工评审与验收归档双关卡。",
    category: "flow",
    agents: 9,
    flows: 1,
    gates: 3,
    scenarios: ["软件研发", "敏捷交付"],
    installed: true,
    hot: true,
  },
  {
    id: "bpt-data-ingest",
    name: "数据采集与入库流程",
    icon: "📥",
    version: "v2.1.0",
    desc: "对接 MySQL / 日志文件等数据源，完成采集、清洗、转换与入库，支持定时调度与失败重试。",
    category: "flow",
    agents: 5,
    flows: 1,
    gates: 1,
    scenarios: ["数据工程", "ETL"],
    installed: false,
  },
  {
    id: "bpt-alert-dispatch",
    name: "告警处置流程",
    icon: "🚨",
    version: "v1.4.2",
    desc: "告警事件自动分级、关联历史案例、生成处置建议，重大告警升级人工确认。",
    category: "flow",
    agents: 4,
    flows: 1,
    gates: 0,
    scenarios: ["运维", "可观测性"],
    installed: false,
  },
  {
    id: "bpt-release",
    name: "发布上线流程",
    icon: "🚀",
    version: "v2.0.1",
    desc: "灰度发布、健康检查、回滚预案一体化，发布窗口与证书续期纳入审批管控。",
    category: "flow",
    agents: 6,
    flows: 1,
    gates: 2,
    scenarios: ["发布", "SRE"],
    installed: false,
  },
  {
    id: "bpt-ticket",
    name: "客户工单处理",
    icon: "🎫",
    version: "v1.0.3",
    desc: "工单自动分诊、知识库检索、回复生成与工单关闭确认，缩短平均响应时长。",
    category: "custom",
    agents: 3,
    flows: 1,
    gates: 1,
    scenarios: ["客服", "定制"],
    installed: false,
  },
  {
    id: "bpt-sql-review",
    name: "SQL 评审工具包",
    icon: "🛠️",
    version: "v0.9.0",
    desc: "SQL 静态检查、执行计划分析、慢查询定位与 DDL 变更风险评估，嵌入代码评审流程。",
    category: "tool",
    agents: 2,
    flows: 0,
    gates: 0,
    scenarios: ["数据库", "代码评审"],
    installed: false,
  },
];

const CATEGORY_META: Record<BlueprintCategory, { text: string; tone: "brand" | "info" | "warning" }> = {
  flow: { text: "流程类", tone: "brand" },
  tool: { text: "工具类", tone: "info" },
  custom: { text: "定制类", tone: "warning" },
};

const FILTERS: Array<{ value: "all" | BlueprintCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "flow", label: "流程类" },
  { value: "tool", label: "工具类" },
  { value: "custom", label: "定制类" },
];

const NAMESPACES = ["default", "dev-team", "test-team"];

/* ---------- 组件 ---------- */

export default function BlueprintMarketPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | BlueprintCategory>("all");
  const [installTarget, setInstallTarget] = useState<Blueprint | null>(null);
  const [installNs, setInstallNs] = useState("default");
  const [justInstalled, setJustInstalled] = useState(false);

  const filtered = BLUEPRINTS.filter((b) => {
    const q = query.trim().toLowerCase();
    const matchQ = q === "" || b.name.toLowerCase().includes(q) || b.desc.toLowerCase().includes(q);
    const matchF = filter === "all" || b.category === filter;
    return matchQ && matchF;
  });

  const openInstall = (b: Blueprint) => {
    setInstallTarget(b);
    setInstallNs("default");
    setJustInstalled(false);
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">业务蓝图市场</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            一键安装开箱即用的业务流程包 · 共 {BLUEPRINTS.length} 个蓝图
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500 shadow-panel">
          <IconPackage className="size-3.5 text-brand-500" />
          已安装 {BLUEPRINTS.filter((b) => b.installed).length} 个
        </span>
      </div>

      {/* 搜索 + 分类 pills */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-80"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索蓝图名称 / 场景…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <div className={`flex gap-1.5 ${mobile ? "flex-wrap" : ""}`}>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                filter === f.value
                  ? "bg-brand-600 font-medium text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 蓝图卡片网格 */}
      {filtered.length === 0 ? (
        <div className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-12 text-center text-sm text-slate-400">
          没有符合条件的蓝图
        </div>
      ) : (
        <ul className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-2 xl:grid-cols-3"}`}>
          {filtered.map((b) => (
            <li
              key={b.id}
              className="group flex flex-col rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel transition-shadow hover:shadow-frame"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-[--radius-control] bg-slate-50 text-xl ring-1 ring-slate-200">
                    {b.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-slate-900">{b.name}</p>
                      {b.hot && (
                        <span className="rounded-full bg-danger-50 px-1.5 py-0.5 text-[10px] font-medium text-danger-600 ring-1 ring-inset ring-danger-500/20">
                          热门
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-slate-400">{b.version}</p>
                  </div>
                </div>
                <StatusBadge tone={CATEGORY_META[b.category].tone}>{CATEGORY_META[b.category].text}</StatusBadge>
              </div>

              <p className="mb-3 flex-1 text-[13px] leading-relaxed text-slate-500">{b.desc}</p>

              {/* 内容统计行 */}
              <div className="mb-3 flex items-center gap-3 rounded-[--radius-control] bg-slate-50 px-3 py-2 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200/70">
                <span className="inline-flex items-center gap-1">
                  <IconUsers className="size-3.5 text-brand-500" />
                  {b.agents} 个 Agent
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconPackage className="size-3.5 text-info-500" />
                  {b.flows} 个流程
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconGate className="size-3.5 text-warning-500" />
                  {b.gates} 个审批关卡
                </span>
              </div>

              <div className="mb-3 flex flex-wrap gap-1">
                {b.scenarios.map((s) => (
                  <span key={s} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                    {s}
                  </span>
                ))}
              </div>

              <div className="border-t border-slate-100 pt-3">
                {b.installed ? (
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs" disabled>
                      已安装 ✓
                    </Button>
                    <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                      查看详情
                    </Button>
                  </div>
                ) : (
                  <Button className="w-full px-2 py-1.5 text-xs" onClick={() => openInstall(b)}>
                    安装到命名空间
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 安装弹窗 */}
      {installTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-frame">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900">
                  安装蓝图：{installTarget.icon} {installTarget.name}
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  {installTarget.version} · {CATEGORY_META[installTarget.category].text}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInstallTarget(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="关闭"
              >
                <IconX className="size-4" />
              </button>
            </div>

            {justInstalled ? (
              <div className="px-5 py-6">
                <div className="flex flex-col items-center text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-success-50 text-success-600">
                    <IconPackage className="size-6" />
                  </span>
                  <p className="mt-3 text-sm font-semibold text-slate-900">安装成功</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    「{installTarget.name}」已安装到命名空间 <span className="font-mono text-slate-700">{installNs}</span>，
                    将在蓝图管理中出现，可随时编排调整。
                  </p>
                </div>
                <Button className="mt-5 w-full" onClick={() => setInstallTarget(null)}>
                  完成
                </Button>
              </div>
            ) : (
              <div className="px-5 py-4">
                <label htmlFor="install-ns" className="mb-1.5 block text-xs font-medium text-slate-600">
                  安装到命名空间
                </label>
                <select
                  id="install-ns"
                  value={installNs}
                  onChange={(e) => setInstallNs(e.target.value)}
                  className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                >
                  {NAMESPACES.map((ns) => (
                    <option key={ns}>{ns}</option>
                  ))}
                </select>

                <p className="mt-4 mb-2 text-xs font-medium text-slate-600">安装后将创建</p>
                <ul className="space-y-1.5 text-xs text-slate-500">
                  <li className="flex items-center gap-2">
                    <IconUsers className="size-3.5 text-brand-500" />
                    {installTarget.agents} 个 Agent 实例（含默认提示词与工具权限）
                  </li>
                  <li className="flex items-center gap-2">
                    <IconPackage className="size-3.5 text-info-500" />
                    {installTarget.flows} 个流程定义（草稿状态，发布后生效）
                  </li>
                  <li className="flex items-center gap-2">
                    <IconGate className="size-3.5 text-warning-500" />
                    {installTarget.gates} 个审批关卡（默认审批人待指定）
                  </li>
                </ul>

                <div className="mt-5 flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setInstallTarget(null)}>
                    取消
                  </Button>
                  <Button className="flex-1" onClick={() => setJustInstalled(true)}>
                    确认安装
                  </Button>
                </div>
                <p className="mt-3 text-center text-[11px] text-slate-400">
                  安装操作将写入审计日志，并需要「蓝图安装」权限
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
