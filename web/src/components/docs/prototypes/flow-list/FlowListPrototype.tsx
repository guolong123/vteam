import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconClock,
  IconEdit,
  IconMore,
  IconPlus,
  IconSearch,
  StatusBadge,
  type Tone,
} from "../_shared/ui";

/**
 * 流程定义列表页原型（组：编排）
 * =====================================================
 * 展示流程定义（Flow Definition）的列表管理：搜索、状态筛选、
 * 版本徽标、节点/审批关卡统计与操作。
 * PC：筛选栏 + 表格；移动端：筛选堆叠、表格切换为卡片。
 */

type FlowStatus = "published" | "draft" | "disabled";

interface FlowDef {
  id: string;
  name: string;
  version: number;
  nodes: number;
  gates: number;
  status: FlowStatus;
  updatedAt: string;
  updatedBy: string;
}

const FLOWS: FlowDef[] = [
  { id: "flw-001", name: "软件公司开发流程", version: 3, nodes: 9, gates: 3, status: "published", updatedAt: "5 分钟前", updatedBy: "陈曦" },
  { id: "flw-002", name: "数据采集任务流程", version: 2, nodes: 6, gates: 1, status: "published", updatedAt: "2 小时前", updatedBy: "林远" },
  { id: "flw-003", name: "告警处理流程", version: 1, nodes: 5, gates: 0, status: "published", updatedAt: "昨天 18:20", updatedBy: "王倩" },
  { id: "flw-004", name: "发布上线流程", version: 4, nodes: 8, gates: 2, status: "draft", updatedAt: "昨天 15:44", updatedBy: "赵磊" },
  { id: "flw-005", name: "配置变更审批流", version: 2, nodes: 4, gates: 1, status: "published", updatedAt: "3 天前", updatedBy: "陈曦" },
  { id: "flw-006", name: "证书续期流程", version: 1, nodes: 3, gates: 1, status: "disabled", updatedAt: "6 天前", updatedBy: "系统管理员" },
  { id: "flw-007", name: "日志仓库重建流程", version: 2, nodes: 4, gates: 0, status: "draft", updatedAt: "上周五", updatedBy: "林远" },
  { id: "flw-008", name: "回归测试流水线", version: 5, nodes: 7, gates: 1, status: "published", updatedAt: "上周三", updatedBy: "赵磊" },
];

const STATUS_META: Record<FlowStatus, { text: string; tone: Tone }> = {
  published: { text: "已发布", tone: "success" },
  draft: { text: "草稿", tone: "warning" },
  disabled: { text: "已停用", tone: "neutral" },
};

const STATUS_OPTIONS: Array<{ value: "all" | FlowStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "published", label: "已发布" },
  { value: "draft", label: "草稿" },
  { value: "disabled", label: "已停用" },
];

function FlowRowActions({ status }: { status: FlowStatus }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" className="px-2 py-1 text-xs">
        <IconEdit className="size-3.5" />
        编辑
      </Button>
      <Button variant="ghost" className="px-2 py-1 text-xs">
        复制
      </Button>
      {status === "published" ? (
        <Button variant="outline" className="px-2 py-1 text-xs">
          停用
        </Button>
      ) : (
        <Button variant="outline" className="px-2 py-1 text-xs">
          发布
        </Button>
      )}
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

function FlowRowCard({ f }: { f: FlowDef }) {
  return (
    <li className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{f.name}</p>
          <p className="font-mono text-[11px] text-slate-400">
            {f.id} · v{f.version}
          </p>
        </div>
        <StatusBadge tone={STATUS_META[f.status].tone}>{STATUS_META[f.status].text}</StatusBadge>
      </div>
      <dl className="space-y-1.5 text-xs text-slate-500">
        <div className="flex justify-between">
          <dt>节点 / 审批关卡</dt>
          <dd className="text-slate-700">
            {f.nodes} 节点 · {f.gates} 关卡
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>最后更新</dt>
          <dd className="inline-flex items-center gap-1.5 text-slate-700">
            <Avatar name={f.updatedBy} size="sm" />
            {f.updatedBy} · {f.updatedAt}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
          <IconEdit className="size-3.5" />
          编辑
        </Button>
        <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs">
          {f.status === "published" ? "停用" : "发布"}
        </Button>
      </div>
    </li>
  );
}

export default function FlowListPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | FlowStatus>("all");

  const filtered = FLOWS.filter((f) => {
    const q = query.trim().toLowerCase();
    const matchQ = q === "" || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q);
    const matchS = statusFilter === "all" || f.status === statusFilter;
    return matchQ && matchS;
  });

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">流程定义</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            共 {FLOWS.length} 个流程 · 编排 Agent、审批关卡与系统节点组成的可执行流水线
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:inline-flex">
            <IconClock className="size-3.5" />
            软件公司开发流程 · 当前 v3，共 2 个历史版本
          </span>
          <Button>
            <IconPlus className="size-4" />
            新建流程
          </Button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-72"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索流程名称…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStatusFilter(opt.value)}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
              statusFilter === opt.value
                ? "bg-brand-600 font-medium text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 列表：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {filtered.map((f) => (
            <FlowRowCard key={f.id} f={f} />
          ))}
          {filtered.length === 0 && (
            <li className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-10 text-center text-sm text-slate-400">
              没有符合条件的流程
            </li>
          )}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">流程名称</th>
                <th className="px-4 py-2.5 font-medium">版本</th>
                <th className="px-4 py-2.5 font-medium">节点</th>
                <th className="px-4 py-2.5 font-medium">审批关卡</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">更新时间</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{f.name}</p>
                    <p className="font-mono text-[11px] text-slate-400">{f.id}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-500/25">
                      v{f.version}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {f.nodes} 个节点
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {f.gates > 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-slate-600">
                        <span className="size-1.5 rounded-full bg-warning-500" />
                        {f.gates} 个审批关卡
                      </span>
                    ) : (
                      <span className="text-slate-400">无审批</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATUS_META[f.status].tone}>
                      {STATUS_META[f.status].text}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-500">
                      <Avatar name={f.updatedBy} size="sm" />
                      {f.updatedBy} · {f.updatedAt}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <FlowRowActions status={f.status} />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的流程
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
