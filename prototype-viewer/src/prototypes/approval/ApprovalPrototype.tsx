import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Avatar, Button, IconClock, StatusBadge, type Tone } from "../_shared/ui";

/**
 * 审批页原型（组：审批）
 * =====================================================
 * 顶部统计 + 待审批卡片列表，每条支持 通过 / 驳回 / 打回。
 * 操作后卡片移动到底部"已处理"列表（静态演示状态流转）。
 */

type ApprovalType = "agent" | "task" | "permission" | "flow";

interface ApprovalItem {
  id: string;
  title: string;
  submitter: string;
  time: string;
  type: ApprovalType;
  summary: string;
}

const TYPE_META: Record<ApprovalType, { text: string; tone: Tone }> = {
  agent: { text: "创建 Agent", tone: "info" },
  task: { text: "任务发布", tone: "brand" },
  permission: { text: "权限变更", tone: "warning" },
  flow: { text: "流程审批", tone: "neutral" },
};

const INITIAL_PENDING: ApprovalItem[] = [
  {
    id: "ap-301",
    title: "申请创建「发布管家」Agent",
    submitter: "赵磊",
    time: "10 分钟前",
    type: "agent",
    summary: "模型 gpt-5.2，挂载 8 个工具（jenkins / deploy / docker），用于发布流水线自动化。",
  },
  {
    id: "ap-302",
    title: "生产环境证书续期任务发布",
    submitter: "王倩",
    time: "32 分钟前",
    type: "task",
    summary: "对 *.ketaops.cc 签发新证书并部署到网关，预计耗时 5 分钟，需停机窗口。",
  },
  {
    id: "ap-303",
    title: "日志分析员授予「写」权限",
    submitter: "陈曦",
    time: "1 小时前",
    type: "permission",
    summary: "为 ag-1002 日志分析员开放 logs 仓库的写入权限，用于执行数据回填任务。",
  },
  {
    id: "ap-304",
    title: "变更：告警规则批量导入流程",
    submitter: "林远",
    time: "2 小时前",
    type: "flow",
    summary: "将 43 条告警规则按新模板批量导入，涉及 2 个命名空间，规则变更将即时生效。",
  },
];

const INITIAL_DONE: ApprovalItem[] = [
  {
    id: "ap-298",
    title: "扩容 agent 集群至 3 节点",
    submitter: "系统管理员",
    time: "昨天 16:20",
    type: "flow",
    summary: "集群资源水位超 70%，申请横向扩容。",
  },
];

export default function ApprovalPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [pending, setPending] = useState<ApprovalItem[]>(INITIAL_PENDING);
  const [done, setDone] = useState<ApprovalItem[]>(INITIAL_DONE);
  const [doneAction, setDoneAction] = useState<Record<string, "通过" | "驳回" | "打回">>({
    "ap-298": "通过",
  });

  const handleAction = (item: ApprovalItem, action: "通过" | "驳回" | "打回") => {
    setPending((prev) => prev.filter((i) => i.id !== item.id));
    setDone((prev) => [item, ...prev]);
    setDoneAction((prev) => ({ ...prev, [item.id]: action }));
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-slate-900">审批中心</h1>
        <p className="mt-0.5 text-sm text-slate-500">人工审批是编排流程的安全闸门，所有关键变更需人工确认</p>
      </div>

      {/* 统计卡 */}
      <div className={`mb-5 grid gap-3 ${mobile ? "grid-cols-3" : "grid-cols-3"}`}>
        <StatCard label="待审批" value={pending.length} accent="bg-brand-500" />
        <StatCard label="今日已处理" value={done.filter((d) => doneAction[d.id]).length + 3} accent="bg-success-500" />
        <StatCard label="平均处理时长" value="4.2 分" accent="bg-warning-500" />
      </div>

      {/* 待审批列表 */}
      <section className="mb-6">
        <h2 className="mb-2.5 text-sm font-semibold text-slate-900">
          待我审批 <span className="ml-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">{pending.length}</span>
        </h2>
        <ul className="space-y-3">
          {pending.map((item) => (
            <li
              key={item.id}
              className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
            >
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-slate-900">{item.title}</p>
                <StatusBadge tone={TYPE_META[item.type].tone}>{TYPE_META[item.type].text}</StatusBadge>
              </div>
              <p className="mb-3 text-[13px] leading-relaxed text-slate-500">{item.summary}</p>
              <div className="mb-3 flex items-center gap-3 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Avatar name={item.submitter} size="sm" />
                  {item.submitter}
                </span>
                <span className="inline-flex items-center gap-1">
                  <IconClock className="size-3.5" />
                  {item.time}
                </span>
                <span className="font-mono">{item.id}</span>
              </div>
              <div className={`flex gap-2 ${mobile ? "" : "justify-end border-t border-slate-100 pt-3"}`}>
                <Button
                  variant="primary"
                  className="flex-1 sm:flex-none"
                  onClick={() => handleAction(item, "通过")}
                >
                  通过
                </Button>
                <Button
                  variant="danger"
                  className="flex-1 sm:flex-none"
                  onClick={() => handleAction(item, "驳回")}
                >
                  驳回
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 sm:flex-none"
                  onClick={() => handleAction(item, "打回")}
                >
                  打回
                </Button>
              </div>
            </li>
          ))}
          {pending.length === 0 && (
            <li className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-10 text-center text-sm text-slate-400">
              暂无待审批事项 🎉
            </li>
          )}
        </ul>
      </section>

      {/* 已处理 */}
      {done.length > 0 && (
        <section>
          <h2 className="mb-2.5 text-sm font-semibold text-slate-900">最近已处理</h2>
          <ul className="space-y-2">
            {done.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-[--radius-card] border border-slate-200 bg-white px-4 py-3 opacity-80"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-700">{item.title}</p>
                  <p className="text-xs text-slate-400">
                    {item.submitter} · {item.time}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    doneAction[item.id] === "通过"
                      ? "bg-success-50 text-success-700"
                      : doneAction[item.id] === "驳回"
                        ? "bg-danger-50 text-danger-700"
                        : "bg-warning-50 text-warning-700"
                  }`}
                >
                  {doneAction[item.id] ?? "已处理"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div className="rounded-[--radius-card] border border-slate-200 bg-white px-3 py-3 shadow-panel sm:px-4">
      <div className={`mb-1.5 h-1 w-6 rounded-full ${accent}`} />
      <p className="text-xl font-semibold text-slate-900 sm:text-2xl">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
    </div>
  );
}
