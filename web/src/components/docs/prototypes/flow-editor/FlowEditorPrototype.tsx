import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Button,
  IconChevronRight,
  IconLock,
  StatusBadge,
  type Tone,
} from "../_shared/ui";

/**
 * 流程编排画布原型（组：编排）· 本轮重点
 * =====================================================
 * 三栏布局：左侧节点库（可拖拽视觉）、中间 DAG 画布（SVG 手绘连线）、
 * 右侧属性面板（点击节点联动）。
 * 展示 Orchestra 核心编排概念：Agent 节点 / 审批 Gate（菱形）/
 * 并行分支与汇合（圆点 + 虚线分组框）。
 * 移动端：画布降级为只读纵向流程图，节点库收为顶部下拉。
 */

type NodeKind = "agent" | "gate" | "system" | "split" | "join" | "end";

interface FlowNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 画布内节点（绝对定位，单位 px，画布 1420x470） */
const NODES: FlowNode[] = [
  { id: "n-demand", kind: "agent", label: "需求分析", sub: "ag-1002 · 日志分析员", x: 0, y: 200, w: 168, h: 72 },
  { id: "gate-req", kind: "gate", label: "需求评审", sub: "人工审批", x: 212, y: 176, w: 120, h: 120 },
  { id: "n-arch", kind: "agent", label: "架构设计", sub: "ag-1008 · 架构师", x: 400, y: 60, w: 168, h: 72 },
  { id: "n-testcase", kind: "agent", label: "测试用例设计", sub: "ag-1009 · 测试工程师", x: 400, y: 330, w: 168, h: 72 },
  { id: "n-code", kind: "agent", label: "编码实现", sub: "ag-1010 · 开发工程师", x: 636, y: 200, w: 168, h: 72 },
  { id: "n-deploy", kind: "system", label: "CI/CD 部署", sub: "Jenkins · prod-cluster", x: 828, y: 200, w: 168, h: 72 },
  { id: "n-test", kind: "agent", label: "测试执行", sub: "ag-1003 · 发布管家", x: 1020, y: 200, w: 168, h: 72 },
  { id: "gate-final", kind: "gate", label: "验收归档", sub: "人工审批", x: 1212, y: 176, w: 120, h: 120 },
];

/** 分支 / 汇合圆点（中心坐标）与终点 */
const DOTS = [
  { id: "split1", label: "分支", cx: 376, cy: 236 },
  { id: "join1", label: "汇合", cx: 612, cy: 236 },
  { id: "end", label: "结束", cx: 1390, cy: 236 },
];

/** 并行分支虚线分组框 */
const PARALLEL_BOX = { x: 384, y: 40, w: 200, h: 380 };

const CANVAS_W = 1420;
const CANVAS_H = 470;

/** 连线：from/to 用于选中高亮 */
const EDGES: Array<{ id: string; from: string; to: string; d: string }> = [
  { id: "e1", from: "n-demand", to: "gate-req", d: "M168 236 H212" },
  { id: "e2", from: "gate-req", to: "split1", d: "M332 236 H366" },
  { id: "e3", from: "split1", to: "n-arch", d: "M376 236 V96 H392" },
  { id: "e4", from: "split1", to: "n-testcase", d: "M376 236 V366 H392" },
  { id: "e5", from: "n-arch", to: "join1", d: "M568 96 H604 V236" },
  { id: "e6", from: "n-testcase", to: "join1", d: "M568 366 H604 V236" },
  { id: "e7", from: "join1", to: "n-code", d: "M620 236 H636" },
  { id: "e8", from: "n-code", to: "n-deploy", d: "M804 236 H828" },
  { id: "e9", from: "n-deploy", to: "n-test", d: "M996 236 H1020" },
  { id: "e10", from: "n-test", to: "gate-final", d: "M1188 236 H1212" },
  { id: "e11", from: "gate-final", to: "end", d: "M1332 236 H1383" },
];

interface NodeDetail {
  badge: string;
  tone: Tone;
  fields: Array<[string, string]>;
}

/** 属性面板数据（点击节点联动） */
const NODE_DETAILS: Record<string, NodeDetail> = {
  "n-demand": {
    badge: "Agent 节点", tone: "brand",
    fields: [
      ["节点名称", "需求分析"],
      ["关联 Agent", "ag-1002 日志分析员"],
      ["模型", "deepseek-v4-flash"],
      ["挂载工具", "4 个（spl-search / log-analysis）"],
      ["条件路由", "入参 { repo, branch }"],
      ["超时", "30 分钟"],
      ["失败策略", "重试 2 次"],
    ],
  },
  "gate-req": {
    badge: "审批 Gate", tone: "warning",
    fields: [
      ["关卡名称", "需求评审"],
      ["审批人", "张三（项目经理）"],
      ["审批超时", "24 小时"],
      ["驳回策略", "返回「需求分析」重做"],
      ["通知方式", "站内信 + 企业微信"],
    ],
  },
  "n-arch": {
    badge: "Agent 节点", tone: "brand",
    fields: [
      ["节点名称", "架构设计"],
      ["关联 Agent", "ag-1008 架构师"],
      ["模型", "gpt-5.2"],
      ["挂载工具", "6 个（git / wiki / diagram）"],
      ["超时", "45 分钟"],
      ["失败策略", "重试 1 次后告警"],
    ],
  },
  "n-testcase": {
    badge: "Agent 节点", tone: "brand",
    fields: [
      ["节点名称", "测试用例设计"],
      ["关联 Agent", "ag-1009 测试工程师"],
      ["模型", "claude-sonnet-4"],
      ["挂载工具", "3 个（jira / testcase）"],
      ["条件路由", "与「架构设计」并行执行"],
    ],
  },
  "n-code": {
    badge: "Agent 节点", tone: "brand",
    fields: [
      ["节点名称", "编码实现"],
      ["关联 Agent", "ag-1010 开发工程师"],
      ["模型", "deepseek-v4-flash"],
      ["挂载工具", "7 个（git / github / code-review）"],
      ["前置条件", "架构设计完成 + 需求评审通过"],
      ["超时", "2 小时"],
    ],
  },
  "n-deploy": {
    badge: "系统节点", tone: "info",
    fields: [
      ["节点名称", "CI/CD 部署"],
      ["集成对象", "Jenkins（job: ketaops-release）"],
      ["目标环境", "prod-cluster"],
      ["触发动作", "build & deploy"],
      ["失败策略", "回滚上一稳定版本"],
    ],
  },
  "n-test": {
    badge: "Agent 节点", tone: "brand",
    fields: [
      ["节点名称", "测试执行"],
      ["关联 Agent", "ag-1003 发布管家"],
      ["模型", "gpt-5.2"],
      ["挂载工具", "8 个（jenkins / test / report）"],
      ["条件路由", "仅当 CI/CD 部署成功"],
      ["超时", "45 分钟"],
    ],
  },
  "gate-final": {
    badge: "审批 Gate", tone: "warning",
    fields: [
      ["关卡名称", "验收归档"],
      ["审批人", "李四（研发总监）"],
      ["审批超时", "48 小时"],
      ["驳回策略", "返回「测试执行」重跑"],
      ["通知方式", "站内信 + 邮件"],
    ],
  },
};

const MOBILE_STEPS: Array<{ id: string; kind: NodeKind; label: string; sub: string }> = [
  { id: "n-demand", kind: "agent", label: "需求分析", sub: "ag-1002 日志分析员" },
  { id: "gate-req", kind: "gate", label: "需求评审", sub: "人工审批 · 张三" },
  { id: "split", kind: "split", label: "并行分支", sub: "两条分支并行执行" },
  { id: "n-arch", kind: "agent", label: "架构设计", sub: "ag-1008 架构师" },
  { id: "n-testcase", kind: "agent", label: "测试用例设计", sub: "ag-1009 测试工程师" },
  { id: "join", kind: "join", label: "汇合", sub: "等待全部分支完成" },
  { id: "n-code", kind: "agent", label: "编码实现", sub: "ag-1010 开发工程师" },
  { id: "n-deploy", kind: "system", label: "CI/CD 部署", sub: "Jenkins · prod-cluster" },
  { id: "n-test", kind: "agent", label: "测试执行", sub: "ag-1003 发布管家" },
  { id: "gate-final", kind: "gate", label: "验收归档", sub: "人工审批 · 李四" },
];

const GRID_BG: CSSProperties = {
  backgroundImage:
    "linear-gradient(to right, rgba(226,232,240,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(226,232,240,0.5) 1px, transparent 1px)",
  backgroundSize: "24px 24px",
};

/* ---------- 节点图标（stroke 风格，与 _shared 一致） ---------- */

function BotIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect width="17" height="12" x="3.5" y="7" rx="2.5" />
      <circle cx="9.5" cy="13" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="0.8" fill="currentColor" stroke="none" />
      <path d="M12 7V4.5M10 2.5h4" />
    </svg>
  );
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect width="18" height="4.5" x="3" y="4" rx="1" />
      <rect width="18" height="4.5" x="3" y="9.75" rx="1" />
      <rect width="18" height="4.5" x="3" y="15.5" rx="1" />
      <path d="M7 6.25h.01M7 12h.01M7 17.75h.01" />
    </svg>
  );
}

function DotIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 8.5v7M8.5 6h7M8.5 18h7" />
    </svg>
  );
}

function KindIcon({ kind, className }: { kind: NodeKind; className?: string }) {
  if (kind === "system") return <ServerIcon className={className} />;
  if (kind === "gate") return <IconLock className={className} />;
  if (kind === "split" || kind === "join") return <DotIcon className={className} />;
  return <BotIcon className={className} />;
}

/* ---------- 画布节点渲染 ---------- */

function AgentNode({ node, selected, onSelect }: { node: FlowNode; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <div
      className="absolute cursor-pointer"
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
    >
      <div
        className={`flex h-full w-full items-center gap-2.5 rounded-[10px] bg-white px-3 transition-shadow ${
          selected
            ? "border-2 border-brand-500 shadow-panel ring-2 ring-brand-500/20"
            : "border border-slate-200 shadow-panel hover:border-brand-300"
        }`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <BotIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-slate-900">{node.label}</p>
          <p className="truncate text-[11px] text-slate-400">{node.sub}</p>
        </div>
        <span className="ml-auto shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          Agent
        </span>
      </div>
    </div>
  );
}

function GateNode({ node, selected, onSelect }: { node: FlowNode; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <div
      className="absolute cursor-pointer"
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
    >
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 120 120" aria-hidden="true">
        <polygon
          points="60,8 112,60 60,112 8,60"
          strokeLinejoin="round"
          strokeWidth={selected ? 2.5 : 1.5}
          className={`${selected ? "fill-warning-50 stroke-brand-500" : "fill-warning-50 stroke-warning-400"}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className="text-warning-600">
          <IconLock className="size-4" />
        </span>
        <p className="text-[13px] font-semibold text-slate-900">{node.label}</p>
        <p className="text-[10px] text-slate-500">{node.sub}</p>
      </div>
    </div>
  );
}

function SystemNode({ node, selected, onSelect }: { node: FlowNode; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <div
      className="absolute cursor-pointer"
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
    >
      <div
        className={`flex h-full w-full items-center gap-2.5 rounded-[10px] bg-info-50/70 px-3 transition-shadow ${
          selected
            ? "border-2 border-brand-500 shadow-panel ring-2 ring-brand-500/20"
            : "border border-info-200 shadow-panel hover:border-info-300"
        }`}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-100 text-info-600">
          <ServerIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-slate-900">{node.label}</p>
          <p className="truncate text-[11px] text-slate-500">{node.sub}</p>
        </div>
        <span className="ml-auto shrink-0 rounded bg-info-100 px-1.5 py-0.5 text-[10px] font-medium text-info-700">
          系统
        </span>
      </div>
    </div>
  );
}

function DotNode({ dot }: { dot: { id: string; label: string; cx: number; cy: number } }) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: dot.cx, top: dot.cy }}
    >
      <span className="block size-5 rounded-full border-2 border-brand-400 bg-white shadow-sm" />
      <span className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-slate-400">
        {dot.label}
      </span>
    </div>
  );
}

/* ---------- 节点库 / 属性面板 ---------- */

const LIB_ITEMS: Array<{ key: string; label: string; desc: string; icon: ReactNode }> = [
  { key: "agent", label: "Agent 节点", desc: "调用 LLM Agent 执行任务，可挂载工具", icon: <BotIcon className="size-4" /> },
  { key: "gate", label: "审批 Gate", desc: "人工审批关卡，关键变更需人确认", icon: <IconLock className="size-4" /> },
  { key: "parallel", label: "并行分支", desc: "并行执行多条分支，全部完成后汇合", icon: <DotIcon className="size-4" /> },
];

function Palette() {
  return (
    <div className="rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel">
      <p className="mb-2.5 text-xs font-semibold text-slate-900">节点库</p>
      <ul className="space-y-2">
        {LIB_ITEMS.map((item) => (
          <li key={item.key}>
            <div className="group cursor-grab rounded-[--radius-control] border border-dashed border-slate-300 bg-slate-50/60 p-2.5 transition-colors hover:border-brand-300 hover:bg-brand-50/50 active:cursor-grabbing">
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md bg-white text-slate-500 ring-1 ring-slate-200 group-hover:text-brand-600">
                  {item.icon}
                </span>
                <p className="text-[13px] font-medium text-slate-800">{item.label}</p>
                <span className="ml-auto text-slate-300 transition-colors group-hover:text-brand-400">⠿</span>
              </div>
              <p className="mt-1.5 pl-9 text-[11px] leading-relaxed text-slate-400">{item.desc}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 rounded-md bg-slate-50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
        拖拽节点到画布放置；审批 Gate 是流程的安全闸门，发布前须通过全部关卡。
      </p>
    </div>
  );
}

function PropertyPanel({ selected }: { selected: string | null }) {
  const detail = selected ? NODE_DETAILS[selected] : null;
  if (!detail) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-[--radius-card] border border-dashed border-slate-300 bg-white/70 px-4 text-center">
        <span className="mb-2 flex size-9 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <IconChevronRight className="size-4 -rotate-90" />
        </span>
        <p className="text-sm font-medium text-slate-600">选择节点查看属性</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          点击画布中的节点，这里会显示关联 Agent、条件路由、审批人等配置
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
      <div className="border-b border-slate-200 px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">节点属性</p>
          <StatusBadge tone={detail.tone}>{detail.badge}</StatusBadge>
        </div>
      </div>
      <dl className="divide-y divide-slate-100 px-3.5">
        {detail.fields.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-xs text-slate-400">{k}</dt>
            <dd className="text-right text-xs font-medium text-slate-700">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex gap-2 border-t border-slate-200 px-3.5 py-3">
        <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
          删除节点
        </Button>
        <Button className="flex-1 px-2 py-1.5 text-xs">保存配置</Button>
      </div>
    </div>
  );
}

/* ---------- 移动端纵向流程 ---------- */

function MobileFlowList({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <ol className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
      {MOBILE_STEPS.map((s, i) => {
        const isLast = i === MOBILE_STEPS.length - 1;
        return (
          <li key={s.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full ring-1 ${
                  s.kind === "gate"
                    ? "bg-warning-50 text-warning-600 ring-warning-500/25"
                    : s.kind === "system"
                      ? "bg-info-50 text-info-600 ring-info-500/25"
                      : "bg-brand-50 text-brand-600 ring-brand-500/25"
                }`}
              >
                <KindIcon kind={s.kind} className="size-3.5" />
              </span>
              {!isLast && <span className="w-px flex-1 bg-slate-200" />}
            </div>
            <button
              type="button"
              className={`min-w-0 flex-1 pb-4 text-left ${isLast ? "pb-0" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <p className="text-[13px] font-medium text-slate-900">{s.label}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{s.sub}</p>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- 主组件 ---------- */

export default function FlowEditorPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [selected, setSelected] = useState<string | null>("n-test");
  const [libOpen, setLibOpen] = useState(false);

  const handleSelect = (id: string) => {
    setSelected(id);
    setLibOpen(false);
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 顶部工具栏 */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[--radius-card] border border-slate-200 bg-white px-3 py-2 shadow-panel">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="hidden text-xs text-slate-400 sm:inline">流程编排</span>
          <IconChevronRight className="hidden size-3.5 text-slate-300 sm:inline" />
          <span className="truncate text-sm font-medium text-slate-900">软件公司开发流程</span>
          <StatusBadge tone="success">已发布 · v3</StatusBadge>
        </div>
        <div className="flex items-center gap-1.5">
          {mobile && (
            <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setLibOpen((v) => !v)}>
              节点库
            </Button>
          )}
          <Button variant="outline" className="px-2.5 py-1 text-xs">校验</Button>
          <Button variant="outline" className="hidden px-2.5 py-1 text-xs sm:inline-flex">自动布局</Button>
          <Button variant="outline" className="px-2.5 py-1 text-xs">保存</Button>
          <Button className="px-2.5 py-1 text-xs">发布</Button>
        </div>
      </div>

      {mobile && libOpen && (
        <div className="mb-3">
          <Palette />
        </div>
      )}

      {/* 三栏：节点库 / 画布 / 属性面板 */}
      <div className={mobile ? "" : "grid grid-cols-[210px_minmax(0,1fr)_272px] items-start gap-3"}>
        {!mobile && <Palette />}

        <section>
          {/* 画布（可横向平移，网格背景） */}
          <div className="relative overflow-hidden rounded-[--radius-frame] border border-slate-200 bg-slate-50/60 shadow-panel">
            <div
              className="overflow-x-auto"
              onClick={() => setSelected(null)}
            >
              {mobile ? (
                <div className="p-4">
                  <MobileFlowList onSelect={handleSelect} />
                  <p className="mt-3 text-center text-[11px] text-slate-400">
                    移动端为只读视图 · 请在 PC 端编辑画布
                  </p>
                </div>
              ) : (
                <div
                  className="relative"
                  style={{ width: CANVAS_W, height: CANVAS_H, ...GRID_BG }}
                >
                  {/* SVG 连线 */}
                  <svg
                    className="pointer-events-none absolute inset-0"
                    width={CANVAS_W}
                    height={CANVAS_H}
                    viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
                  >
                    <defs>
                      <marker
                        id="arr"
                        viewBox="0 0 10 10"
                        refX="8.5"
                        refY="5"
                        markerWidth="5.5"
                        markerHeight="5.5"
                        orient="auto-start-reverse"
                      >
                        <path d="M0 0L10 5L0 10z" fill="currentColor" />
                      </marker>
                    </defs>
                    {EDGES.map((e) => {
                      const hot = selected === e.from || selected === e.to;
                      return (
                        <path
                          key={e.id}
                          d={e.d}
                          fill="none"
                          markerEnd="url(#arr)"
                          className={`${hot ? "text-brand-500" : "text-slate-300"} transition-colors`}
                          stroke="currentColor"
                          strokeWidth={hot ? 2.5 : 1.5}
                          strokeDasharray={hot ? "0" : undefined}
                        />
                      );
                    })}
                  </svg>

                  {/* 并行分支虚线分组框 */}
                  <div
                    className="absolute rounded-[10px] border border-dashed border-brand-300/70 bg-brand-50/30"
                    style={{ left: PARALLEL_BOX.x, top: PARALLEL_BOX.y, width: PARALLEL_BOX.w, height: PARALLEL_BOX.h }}
                  >
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-300/60">
                      并行分支
                    </span>
                  </div>

                  {/* 节点 */}
                  {NODES.map((n) => {
                    if (n.kind === "agent") return <AgentNode key={n.id} node={n} selected={selected === n.id} onSelect={handleSelect} />;
                    if (n.kind === "gate") return <GateNode key={n.id} node={n} selected={selected === n.id} onSelect={handleSelect} />;
                    return <SystemNode key={n.id} node={n} selected={selected === n.id} onSelect={handleSelect} />;
                  })}
                  {DOTS.map((d) => (
                    <DotNode key={d.id} dot={d} />
                  ))}
                </div>
              )}
            </div>

            {/* 画布状态条：平移暗示 + 缩放 */}
            <div className="flex items-center justify-between border-t border-slate-200 bg-white px-3 py-1.5">
              <p className="text-[11px] text-slate-400">
                {mobile ? "只读纵向视图" : "拖拽空白处平移 · 滚轮缩放 · 点击节点查看属性"}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-slate-500">
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100">−</button>
                <span className="font-mono">100%</span>
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100">+</button>
              </div>
            </div>
          </div>

          {/* 移动端：属性面板置底 */}
          {mobile && (
            <div className="mt-3">
              <PropertyPanel selected={selected} />
            </div>
          )}
        </section>

        {!mobile && <PropertyPanel selected={selected} />}
      </div>
    </div>
  );
}
