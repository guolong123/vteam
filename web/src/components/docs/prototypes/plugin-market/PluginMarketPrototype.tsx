import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconSearch, StatusBadge, type Tone } from "../_shared/ui";

/**
 * 插件市场页原型（组：生态）
 * =====================================================
 * 顶部：搜索 + 分类筛选 pills（全部 / 官方 / 社区 / 已安装）；
 * 插件卡片网格（PC 3 列、移动端单列），卡片含图标、来源 badge、
 * 集成对象标签与安装按钮。纯 UI 原型，无真实安装逻辑。
 */

type Source = "official" | "community";

interface Plugin {
  id: string;
  name: string;
  icon: string;
  desc: string;
  source: Source;
  version: string;
  integrations: string[];
  installed: boolean;
}

const PLUGINS: Plugin[] = [
  {
    id: "plg-jenkins",
    name: "Jenkins 集成",
    icon: "🏗️",
    desc: "触发构建、查询构建状态、拉取产物，让 Agent 接管发布流水线。",
    source: "official",
    version: "v2.4.1",
    integrations: ["Jenkins"],
    installed: true,
  },
  {
    id: "plg-github",
    name: "GitHub 集成",
    icon: "🐙",
    desc: "创建 PR、评论、合并、读取仓库状态，打通代码协作闭环。",
    source: "official",
    version: "v1.8.0",
    integrations: ["GitHub"],
    installed: true,
  },
  {
    id: "plg-mcp",
    name: "MCP 连接器",
    icon: "🔌",
    desc: "通过 MCP 协议接入任意工具服务器，一个插件连通整个生态。",
    source: "official",
    version: "v0.9.5",
    integrations: ["MCP"],
    installed: true,
  },
  {
    id: "plg-gitee",
    name: "Gitee 集成",
    icon: "🦊",
    desc: "创建 PR / Issue、代码评论与合并请求管理，适配国内研发流程。",
    source: "official",
    version: "v1.3.2",
    integrations: ["Gitee"],
    installed: false,
  },
  {
    id: "plg-wecom",
    name: "企业微信通知",
    icon: "💬",
    desc: "任务完成、审批待办、告警事件推送企业微信机器人消息。",
    source: "community",
    version: "v1.1.0",
    integrations: ["企业微信"],
    installed: false,
  },
  {
    id: "plg-pg",
    name: "PostgreSQL 工具",
    icon: "🐘",
    desc: "执行 SQL、以表格形式返回查询结果，支持参数化与结果缓存。",
    source: "community",
    version: "v0.6.3",
    integrations: ["PostgreSQL"],
    installed: false,
  },
  {
    id: "plg-lark",
    name: "飞书文档同步",
    icon: "📄",
    desc: "导出会议纪要、创建/更新飞书文档，沉淀 Agent 工作产物。",
    source: "community",
    version: "v0.4.1",
    integrations: ["飞书"],
    installed: true,
  },
  {
    id: "plg-jira",
    name: "Jira 集成",
    icon: "📋",
    desc: "创建与更新工单、同步迭代状态，连接需求与执行。",
    source: "official",
    version: "v1.0.0",
    integrations: ["Jira"],
    installed: false,
  },
];

const SOURCE_META: Record<Source, { text: string; tone: Tone }> = {
  official: { text: "官方", tone: "brand" },
  community: { text: "社区", tone: "neutral" },
};

const FILTERS: Array<{ value: "all" | Source | "installed"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "official", label: "官方" },
  { value: "community", label: "社区" },
  { value: "installed", label: "已安装" },
];

export default function PluginMarketPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Source | "installed">("all");

  const filtered = PLUGINS.filter((p) => {
    const q = query.trim().toLowerCase();
    const matchQ = q === "" || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q);
    const matchF =
      filter === "all" || (filter === "installed" ? p.installed : p.source === filter);
    return matchQ && matchF;
  });

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">插件市场</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            为 Agent 与流程扩展集成能力 · 共 {PLUGINS.length} 个插件，已安装 {PLUGINS.filter((p) => p.installed).length} 个
          </p>
        </div>
        <Button variant="outline" className="px-3 py-1.5 text-xs">
          管理已安装
        </Button>
      </div>

      {/* 搜索 + 分类 pills */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-80"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件名称 / 能力…"
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

      {/* 插件卡片网格 */}
      {filtered.length === 0 ? (
        <div className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-12 text-center text-sm text-slate-400">
          没有符合条件的插件
        </div>
      ) : (
        <ul className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-2 xl:grid-cols-3"}`}>
          {filtered.map((p) => (
            <li
              key={p.id}
              className="group flex flex-col rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel transition-shadow hover:shadow-frame"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-[--radius-control] bg-slate-50 text-xl ring-1 ring-slate-200">
                    {p.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{p.name}</p>
                    <p className="font-mono text-[11px] text-slate-400">{p.version}</p>
                  </div>
                </div>
                <StatusBadge tone={SOURCE_META[p.source].tone}>{SOURCE_META[p.source].text}</StatusBadge>
              </div>

              <p className="mb-3 flex-1 text-[13px] leading-relaxed text-slate-500">{p.desc}</p>

              <div className="mb-3 flex flex-wrap gap-1">
                {p.integrations.map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500"
                  >
                    {t}
                  </span>
                ))}
              </div>

              <div className="border-t border-slate-100 pt-3">
                {p.installed ? (
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs" disabled>
                      已安装 ✓
                    </Button>
                    <Button className="flex-1 px-2 py-1.5 text-xs">配置</Button>
                  </div>
                ) : (
                  <Button className="w-full px-2 py-1.5 text-xs">安装</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 页脚提示 */}
      <p className="mt-4 text-center text-[11px] text-slate-400">
        插件通过沙箱执行，安装前会进行安全校验与权限审批
      </p>
    </div>
  );
}
