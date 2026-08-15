import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconEdit, IconMore, IconPlus, ProgressBar, StatusBadge } from "../_shared/ui";

/**
 * 命名空间（多租户）管理页原型（组：设置）
 * =====================================================
 * PC：命名空间卡片网格（2~3 列）+ 配额使用条；移动端：卡片单列。
 * 纯 UI 原型：搜索 / 新建弹窗为本地交互，无真实配额逻辑。
 */

interface Namespace {
  id: string;
  name: string;
  desc: string;
  members: number;
  agents: number;
  flows: number;
  tasks: number;
  credUsed: number;
  credMax: number;
  createdAt: string;
  active: boolean;
  system?: boolean;
  quotaWarn?: boolean;
}

const NAMESPACES: Namespace[] = [
  {
    id: "ns-system",
    name: "system",
    desc: "系统全局命名空间，承载共享 Agent 与基础插件，不可停用。",
    members: 8,
    agents: 12,
    flows: 8,
    tasks: 156,
    credUsed: 5,
    credMax: 10,
    createdAt: "2025-12-01",
    active: true,
    system: true,
  },
  {
    id: "ns-default",
    name: "default",
    desc: "默认命名空间，未指定归属的资源默认落于此。",
    members: 15,
    agents: 6,
    flows: 3,
    tasks: 89,
    credUsed: 3,
    credMax: 10,
    createdAt: "2026-01-10",
    active: true,
  },
  {
    id: "ns-dev",
    name: "dev-team",
    desc: "开发团队命名空间，承载需求、编码与代码评审相关流程，活跃度最高。",
    members: 24,
    agents: 9,
    flows: 12,
    tasks: 342,
    credUsed: 8,
    credMax: 10,
    createdAt: "2026-02-18",
    active: true,
    quotaWarn: true,
  },
  {
    id: "ns-test",
    name: "test-team",
    desc: "测试团队命名空间，测试用例生成与质量检查流程运行于此。",
    members: 12,
    agents: 4,
    flows: 6,
    tasks: 210,
    credUsed: 4,
    credMax: 10,
    createdAt: "2026-03-05",
    active: true,
  },
  {
    id: "ns-ops",
    name: "ops",
    desc: "运维团队命名空间，环境巡检与发布流水线专属。",
    members: 9,
    agents: 5,
    flows: 7,
    tasks: 178,
    credUsed: 2,
    credMax: 10,
    createdAt: "2026-03-22",
    active: true,
  },
  {
    id: "ns-customer-a",
    name: "customer-a",
    desc: "客户 A 隔离命名空间，独立配额与凭证，与其他租户物理隔离。",
    members: 3,
    agents: 1,
    flows: 2,
    tasks: 15,
    credUsed: 10,
    credMax: 10,
    createdAt: "2026-05-30",
    active: false,
    quotaWarn: true,
  },
];

function quotaTone(used: number, max: number): "brand" | "warning" | "danger" {
  const pct = used / max;
  if (pct >= 1) return "danger";
  if (pct >= 0.7) return "warning";
  return "brand";
}

/** 内联图标：成员 / 配额 / 层叠（命名空间） */
function IconUsers({ className = "size-4" }: { className?: string }) {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconGauge({ className = "size-4" }: { className?: string }) {
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
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

function IconLayers({ className = "size-4" }: { className?: string }) {
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
      <path d="m12 2 8.5 4.5L12 11 3.5 6.5 12 2Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 17 8.5 4.5 8.5-4.5" />
    </svg>
  );
}

/** 创建命名空间弹窗（纯 UI） */
function CreateNamespaceModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="创建命名空间"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[--radius-card] border border-slate-200 bg-white shadow-frame"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <IconLayers className="size-4 text-brand-600" />
            <h3 className="text-sm font-semibold text-slate-900">创建命名空间</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">命名空间名称</label>
            <input
              type="text"
              placeholder="如 new-team（小写字母 / 数字 / 中划线）"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">描述</label>
            <textarea
              rows={2}
              placeholder="这个命名空间的用途…"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Agent 配额</label>
              <input
                type="number"
                defaultValue={10}
                className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">凭证配额</label>
              <input
                type="number"
                defaultValue={10}
                className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onClose}>
            <IconPlus className="size-4" />
            创建命名空间
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function NamespaceManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [creating, setCreating] = useState(false);

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">命名空间管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            共 {NAMESPACES.length} 个命名空间 · 多租户资源与配额隔离，资源归属命名空间
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <IconPlus className="size-4" />
          创建命名空间
        </Button>
      </div>

      {/* 卡片网格 */}
      <ul className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-2 xl:grid-cols-3"}`}>
        {NAMESPACES.map((ns) => {
          const quotaPct = Math.round((ns.credUsed / ns.credMax) * 100);
          return (
            <li
              key={ns.id}
              className={`flex flex-col rounded-[--radius-card] border bg-white p-4 shadow-panel transition-shadow hover:shadow-frame ${
                ns.active ? "border-slate-200" : "border-slate-200 bg-slate-50/70"
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-brand-500/20">
                    <IconLayers className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-semibold text-slate-900">{ns.name}</p>
                    <p className="text-[11px] text-slate-400">创建于 {ns.createdAt}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {ns.system && (
                    <StatusBadge tone="brand" dot={false}>
                      系统保留
                    </StatusBadge>
                  )}
                  <StatusBadge tone={ns.active ? "success" : "neutral"}>
                    {ns.active ? "活跃" : "已停用"}
                  </StatusBadge>
                </div>
              </div>

              <p className="mb-3 text-[13px] leading-relaxed text-slate-500">{ns.desc}</p>

              {/* 成员 + 资源统计 */}
              <div className="mb-3 grid grid-cols-4 gap-2 rounded-[--radius-control] bg-slate-50 p-2.5 ring-1 ring-slate-100">
                <div className="flex flex-col items-center gap-1">
                  <IconUsers className="size-3.5 text-slate-400" />
                  <span className="text-sm font-semibold text-slate-800">{ns.members}</span>
                  <span className="text-[10px] text-slate-400">成员</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold text-slate-800">{ns.agents}</span>
                  <span className="text-[10px] text-slate-400">Agent</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold text-slate-800">{ns.flows}</span>
                  <span className="text-[10px] text-slate-400">流程</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold text-slate-800">{ns.tasks}</span>
                  <span className="text-[10px] text-slate-400">任务</span>
                </div>
              </div>

              {/* 配额使用 */}
              <div className="mb-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1 text-slate-500">
                    <IconGauge className="size-3.5" />
                    凭证配额
                  </span>
                  <span className={quotaPct >= 100 ? "font-medium text-danger-600" : quotaPct >= 70 ? "font-medium text-warning-700" : "text-slate-600"}>
                    {ns.credUsed}/{ns.credMax}
                    {ns.quotaWarn && quotaPct >= 100 && <span className="ml-1 text-[10px]">已用尽</span>}
                  </span>
                </div>
                <ProgressBar value={quotaPct} tone={quotaTone(ns.credUsed, ns.credMax)} />
              </div>

              {/* 操作 */}
              <div className="mt-auto flex gap-2 border-t border-slate-100 pt-3">
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                  <IconUsers className="size-3.5" />
                  管理成员
                </Button>
                <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs">
                  <IconEdit className="size-3.5" />
                  资源配额
                </Button>
                <button
                  type="button"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="更多操作"
                >
                  <IconMore className="size-4" />
                </button>
              </div>
              {!ns.active && (
                <p className="mt-2 text-center text-[11px] text-slate-400">已停用，资源仅保留不可调度</p>
              )}
            </li>
          );
        })}
      </ul>

      {/* 创建命名空间弹窗 */}
      {creating && <CreateNamespaceModal onClose={() => setCreating(false)} />}
    </div>
  );
}
