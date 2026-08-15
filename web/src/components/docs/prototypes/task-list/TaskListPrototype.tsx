import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconClock,
  IconRefresh,
  IconSearch,
  ProgressBar,
  StatusBadge,
} from "../_shared/ui";

/**
 * 任务列表页原型（组：任务）
 * =====================================================
 * PC：筛选栏 + 表格（运行中任务带进度条）；移动端：筛选堆叠、表格切换为卡片。
 */

type TaskStatus = "running" | "success" | "failed" | "pending";

interface Task {
  id: string;
  name: string;
  flow: string;
  status: TaskStatus;
  progress: number; // 0-100
  duration: string;
  owner: string;
  createdAt: string;
}

const TASKS: Task[] = [
  { id: "tsk-8021", name: "发布 ketaops v3.2.1", flow: "发布流水线 v4", status: "running", progress: 64, duration: "4 分 12 秒", owner: "陈曦", createdAt: "10:24" },
  { id: "tsk-8020", name: "全量回归测试 · 核心模块", flow: "回归测试流水线", status: "running", progress: 28, duration: "8 分 40 秒", owner: "林远", createdAt: "10:18" },
  { id: "tsk-8019", name: "夜间 ETL 数据同步", flow: "数据同步任务", status: "success", progress: 100, duration: "32 分 05 秒", owner: "系统调度", createdAt: "03:00" },
  { id: "tsk-8018", name: "日志仓库滚动重建", flow: "索引维护任务", status: "success", progress: 100, duration: "12 分 44 秒", owner: "系统调度", createdAt: "02:15" },
  { id: "tsk-8017", name: "告警规则批量导入", flow: "配置变更审批流", status: "pending", progress: 0, duration: "—", owner: "王倩", createdAt: "09:02" },
  { id: "tsk-8016", name: "生产环境证书续期", flow: "发布流水线 v4", status: "failed", progress: 42, duration: "2 分 18 秒", owner: "赵磊", createdAt: "昨天 18:40" },
  { id: "tsk-8015", name: "清洗 6 月访问日志", flow: "数据同步任务", status: "failed", progress: 13, duration: "1 分 57 秒", owner: "陈曦", createdAt: "昨天 17:05" },
];

const STATUS_META: Record<TaskStatus, { text: string; tone: "brand" | "success" | "danger" | "warning" }> = {
  running: { text: "运行中", tone: "brand" },
  success: { text: "成功", tone: "success" },
  failed: { text: "失败", tone: "danger" },
  pending: { text: "等待审批", tone: "warning" },
};

const STATUS_OPTIONS: Array<{ value: "all" | TaskStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "pending", label: "等待审批" },
];

function TaskRowActions({ status }: { status: TaskStatus }) {
  return (
    <div className="flex items-center justify-end gap-1 opacity-100 lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100">
      <Button variant="ghost" className="px-2 py-1 text-xs">
        详情
      </Button>
      {status === "running" && (
        <Button variant="outline" className="px-2 py-1 text-xs">
          暂停
        </Button>
      )}
      {(status === "failed" || status === "pending") && (
        <Button variant="outline" className="px-2 py-1 text-xs">
          <IconRefresh className="size-3.5" />
          重试
        </Button>
      )}
    </div>
  );
}

function ProgressCell({ task }: { task: Task }) {
  if (task.status === "pending") return <span className="text-xs text-slate-400">未开始</span>;
  if (task.status === "success") return <span className="text-xs text-slate-500">已完成</span>;
  const tone = task.status === "running" ? "brand" : "danger";
  return (
    <div className="flex w-36 items-center gap-2">
      <ProgressBar value={task.progress} tone={tone} />
      <span className="w-8 shrink-0 text-right font-mono text-xs text-slate-600">
        {task.progress}%
      </span>
    </div>
  );
}

export default function TaskListPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [status, setStatus] = useState<"all" | TaskStatus>("all");
  const [query, setQuery] = useState("");

  const filtered = TASKS.filter((t) => {
    const q = query.trim().toLowerCase();
    const matchQ = q === "" || t.name.toLowerCase().includes(q) || t.flow.toLowerCase().includes(q);
    const matchS = status === "all" || t.status === status;
    return matchQ && matchS;
  });

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-slate-900">任务列表</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          查看与操作编排流水线中的运行任务
        </p>
      </div>

      {/* 筛选栏 */}
      <div className={`mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel ${mobile ? "flex-col" : "items-center"}`}>
        <div className={`relative ${mobile ? "w-full" : "w-64"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务名 / 流程…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStatus(opt.value)}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
              status === opt.value
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
          {filtered.map((t) => (
            <li
              key={t.id}
              className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-slate-900">{t.name}</p>
                <StatusBadge tone={STATUS_META[t.status].tone}>
                  {STATUS_META[t.status].text}
                </StatusBadge>
              </div>
              <p className="mb-3 text-xs text-slate-500">
                {t.flow} · <span className="font-mono">{t.id}</span>
              </p>
              {t.status !== "pending" && (
                <div className="mb-3">
                  <ProgressBar
                    value={t.progress}
                    tone={t.status === "success" ? "success" : t.status === "running" ? "brand" : "danger"}
                  />
                  <p className="mt-1 font-mono text-[11px] text-slate-400">
                    {t.status === "success" ? "已完成" : `${t.progress}%`}
                  </p>
                </div>
              )}
              <dl className="space-y-1.5 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                <div className="flex items-center justify-between">
                  <dt className="inline-flex items-center gap-1">
                    <IconClock className="size-3.5" />
                    耗时
                  </dt>
                  <dd className="font-mono text-slate-700">{t.duration}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>提交人</dt>
                  <dd className="inline-flex items-center gap-1.5 text-slate-700">
                    <Avatar name={t.owner} size="sm" />
                    {t.owner}
                  </dd>
                </div>
              </dl>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                  详情
                </Button>
                {(t.status === "failed" || t.status === "pending") && (
                  <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                    <IconRefresh className="size-3.5" />
                    重试
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5 font-medium">任务</th>
                <th className="px-4 py-2.5 font-medium">流程</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">进度</th>
                <th className="px-4 py-2.5 font-medium">耗时</th>
                <th className="px-4 py-2.5 font-medium">提交人</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{t.name}</p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {t.id} · {t.createdAt}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{t.flow}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATUS_META[t.status].tone}>
                      {STATUS_META[t.status].text}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3">
                    <ProgressCell task={t} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{t.duration}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-600">
                      <Avatar name={t.owner} size="sm" />
                      {t.owner}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <TaskRowActions status={t.status} />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的任务
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
