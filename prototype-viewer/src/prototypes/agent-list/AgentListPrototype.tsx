import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconEdit,
  IconMore,
  IconPlus,
  IconSearch,
  StatusBadge,
} from "../_shared/ui";

/**
 * Agent 管理列表页原型（组：管理）
 * =====================================================
 * PC：搜索 + 筛选 + 表格 + 分页；移动端：筛选堆叠、表格切换为卡片。
 */

type AgentStatus = "online" | "offline" | "busy" | "error";

interface Agent {
  id: string;
  name: string;
  model: string;
  tools: number;
  skills: string[];
  status: AgentStatus;
  active: string;
}

const AGENTS: Agent[] = [
  { id: "ag-1001", name: "代码审查助手", model: "deepseek-v4-flash", tools: 6, skills: ["code-review", "git"], status: "online", active: "2 分钟前" },
  { id: "ag-1002", name: "日志分析员", model: "claude-sonnet-4", tools: 4, skills: ["spl-search", "log-analysis"], status: "online", active: "刚刚" },
  { id: "ag-1003", name: "发布管家", model: "gpt-5.2", tools: 8, skills: ["jenkins", "deploy", "docker"], status: "busy", active: "1 小时前" },
  { id: "ag-1004", name: "工单客服", model: "deepseek-v4-flash", tools: 3, skills: ["ticket", "email"], status: "offline", active: "3 天前" },
  { id: "ag-1005", name: "数据清洗工", model: "qwen-max-2026", tools: 5, skills: ["etl", "quality"], status: "online", active: "8 分钟前" },
  { id: "ag-1006", name: "安全审计员", model: "gpt-5.2", tools: 7, skills: ["security", "audit"], status: "error", active: "昨天 22:14" },
  { id: "ag-1007", name: "知识库索引", model: "claude-sonnet-4", tools: 2, skills: ["wiki"], status: "online", active: "15 分钟前" },
];

const STATUS_LABEL: Record<AgentStatus, { text: string; tone: "success" | "neutral" | "warning" | "danger" }> = {
  online: { text: "在线", tone: "success" },
  offline: { text: "离线", tone: "neutral" },
  busy: { text: "忙碌", tone: "warning" },
  error: { text: "异常", tone: "danger" },
};

function AgentRowActions() {
  return (
    <div className="flex items-center justify-end gap-1 opacity-100 lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100">
      <Button variant="ghost" className="px-2 py-1 text-xs">
        <IconEdit className="size-3.5" />
        编辑
      </Button>
      <button
        type="button"
        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        aria-label="更多操作"
      >
        <IconMore className="size-4" />
      </button>
    </div>
  );
}

function SkillChips({ skills }: { skills: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {skills.slice(0, 3).map((s) => (
        <span
          key={s}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500"
        >
          {s}
        </span>
      ))}
      {skills.length > 3 && (
        <span className="px-1 text-[11px] text-slate-400">+{skills.length - 3}</span>
      )}
    </div>
  );
}

export default function AgentListPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AgentStatus>("all");

  const filtered = AGENTS.filter((a) => {
    const q = query.trim().toLowerCase();
    const matchQ =
      q === "" || a.name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q);
    const matchS = statusFilter === "all" || a.status === statusFilter;
    return matchQ && matchS;
  });

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Agent 管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            共 {AGENTS.length} 个 Agent · 管理智能体实例的创建、运行与回收
          </p>
        </div>
        <Button>
          <IconPlus className="size-4" />
          新建 Agent
        </Button>
      </div>

      {/* 筛选栏 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-64"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 模型…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | AgentStatus)}
          className={`rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 ${mobile ? "w-full" : ""}`}
        >
          <option value="all">全部状态</option>
          <option value="online">在线</option>
          <option value="busy">忙碌</option>
          <option value="offline">离线</option>
          <option value="error">异常</option>
        </select>
        <button
          type="button"
          className="ml-auto hidden items-center gap-1.5 rounded-[--radius-control] px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 sm:inline-flex"
        >
          <IconMore className="size-4" />
          更多筛选
        </button>
      </div>

      {/* 列表：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {filtered.map((a) => (
            <li
              key={a.id}
              className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
            >
              <div className="mb-2.5 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={a.name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{a.name}</p>
                    <p className="font-mono text-[11px] text-slate-400">{a.id}</p>
                  </div>
                </div>
                <StatusBadge tone={STATUS_LABEL[a.status].tone}>
                  {STATUS_LABEL[a.status].text}
                </StatusBadge>
              </div>
              <dl className="space-y-1.5 text-xs text-slate-500">
                <div className="flex justify-between">
                  <dt>模型</dt>
                  <dd className="font-mono text-slate-700">{a.model}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>工具 / 技能</dt>
                  <dd className="text-slate-700">
                    {a.tools} 个工具 · {a.skills.length} 项技能
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>最近活跃</dt>
                  <dd className="text-slate-700">{a.active}</dd>
                </div>
              </dl>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                  <IconEdit className="size-3.5" />
                  编辑
                </Button>
                <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs">
                  更多
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">模型</th>
                <th className="px-4 py-2.5 font-medium">工具</th>
                <th className="px-4 py-2.5 font-medium">技能</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">最近活跃</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={a.name} size="sm" />
                      <div>
                        <p className="font-medium text-slate-900">{a.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{a.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-slate-600">{a.model}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{a.tools}</td>
                  <td className="px-4 py-3">
                    <SkillChips skills={a.skills} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATUS_LABEL[a.status].tone}>
                      {STATUS_LABEL[a.status].text}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{a.active}</td>
                  <td className="px-4 py-3">
                    <AgentRowActions />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的 Agent
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* 分页条 */}
          <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2.5">
            <p className="text-xs text-slate-500">
              共 <span className="font-medium text-slate-700">24</span> 条 · 当前第 1 页
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled
                className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-300"
              >
                上一页
              </button>
              {[1, 2, 3, 4].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs ${
                    p === 1
                      ? "bg-brand-600 font-medium text-white"
                      : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                type="button"
                className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
