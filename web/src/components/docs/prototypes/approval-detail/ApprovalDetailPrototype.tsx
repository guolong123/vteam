import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import {
  Avatar,
  Button,
  IconClock,
  StatusBadge,
} from "../_shared/ui";

/**
 * 审批详情页原型（组：审批，approval 之后）
 * =====================================================
 * 左：产物预览（纯 CSS Markdown 风格渲染需求文档）；
 * 右：审批信息；底部决策区（意见 + 通过/驳回/打回）；
 * 下方：审批历史（打回 → 重新提交流转）。纯 UI 交互。
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

const IconCheck = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

const IconX = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

const IconRotateCcw = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);

const IconFile = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M9 13h6M9 17h6" />
  </Icon>
);

const IconUser = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </Icon>
);

const IconLink = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Icon>
);

const IconAlertCircle = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  </Icon>
);

/* ---------- 数据 ---------- */

interface HistoryRound {
  round: number;
  date: string;
  author: string;
  role: string;
  action: "打回" | "重新提交" | "待审批";
  comment: string;
  isCurrent?: boolean;
}

const HISTORY: HistoryRound[] = [
  { round: 1, date: "07-18 15:22", author: "李四", role: "研发总监", action: "打回", comment: "缺少明确的验收标准，请补充可量化的验收指标。" },
  { round: 2, date: "07-19 10:05", author: "王五", role: "需求分析 Agent", action: "重新提交", comment: "已按意见补充「验收标准」章节，并调整功能优先级。" },
  { round: 3, date: "07-20 09:41", author: "王五", role: "需求分析 Agent", action: "待审批", comment: "等待审批人确认。", isCurrent: true },
];

const INFO_ROWS = [
  { label: "产生 Agent", value: "需求分析 Agent", sub: "ag-1001" },
  { label: "Checkpoint", value: "需求评审", sub: "软件公司开发流程 v3 · 第 2 节点" },
  { label: "提交时间", value: "2026-07-20 09:41", sub: "第 3 轮提交" },
];

/* ---------- 组件 ---------- */

export default function ApprovalDetailPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [comment, setComment] = useState("");

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <StatusBadge tone="warning">需求评审</StatusBadge>
            <h1 className="text-lg font-semibold text-slate-900">需求文档评审：客户门户改版</h1>
            <StatusBadge tone="warning">待审批</StatusBadge>
            <span className="font-mono text-xs text-slate-400">ap-305</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            软件公司开发流程 v3 · 第 2 个节点「需求评审」产生的人工审批
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="px-3 py-1.5 text-xs">催办</Button>
          <Button variant="outline" className="px-3 py-1.5 text-xs">查看上下文</Button>
        </div>
      </div>

      {/* 主区两栏 */}
      <div className={`grid items-start gap-4 ${mobile ? "grid-cols-1" : "grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"}`}>
        {/* 左：产物预览 */}
        <section className="overflow-hidden rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <IconFile className="size-4 text-slate-400" />
              <p className="text-sm font-semibold text-slate-900">需求文档（v2）</p>
            </div>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200">
              markdown · 3.2 KB
            </span>
          </div>

          {/* Markdown 风格渲染（纯 CSS） */}
          <div className="space-y-4 px-5 py-5 text-[13px] leading-relaxed text-slate-700 sm:px-6">
            <div>
              <p className="font-mono text-[11px] text-slate-400"># 客户门户改版 · 需求文档</p>
              <h1 className="mt-1 text-base font-semibold text-slate-900">客户门户改版需求文档</h1>
              <p className="mt-0.5 text-xs text-slate-400">文档编号 DOC-2026-0716 · 版本 v2</p>
            </div>

            <section>
              <p className="font-mono text-[11px] text-slate-400">## 背景与目标</p>
              <h2 className="mt-1 text-sm font-semibold text-slate-900">背景与目标</h2>
              <p className="mt-1 text-slate-600">
                现有客户门户基于 <strong className="font-semibold text-slate-800">单体架构</strong> 开发，
                页面响应时间超过 <strong className="font-semibold text-slate-800">3 秒</strong>，且无法支撑多租户隔离。
                本次改版目标是将门户拆分为独立前端应用，并与 KetaDB 数据服务完成对接。
              </p>
              <blockquote className="mt-2 border-l-3 border-brand-400 bg-brand-50/60 px-3 py-2 text-slate-600">
                范围约束：本次改版仅涉及门户前端与 API 网关，不包含数据仓库侧改造。
              </blockquote>
            </section>

            <section>
              <p className="font-mono text-[11px] text-slate-400">## 功能需求</p>
              <h2 className="mt-1 text-sm font-semibold text-slate-900">功能需求</h2>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-slate-600">
                <li>
                  统一登录入口，支持 <strong className="font-semibold text-slate-800">CAS / OIDC</strong> 双协议
                </li>
                <li>仪表盘支持拖拽布局与模板变量</li>
                <li>告警列表实时刷新（WebSocket），延迟小于 2 秒</li>
                <li>导出报表支持 CSV / Excel 两种格式</li>
              </ul>
            </section>

            <section>
              <p className="font-mono text-[11px] text-slate-400">## 验收标准</p>
              <h2 className="mt-1 text-sm font-semibold text-slate-900">验收标准</h2>
              <ul className="mt-1.5 list-decimal space-y-1 pl-5 text-slate-600">
                <li>核心页面首屏耗时 <strong className="font-semibold text-slate-800">&lt; 1.5 秒</strong>（P95）</li>
                <li>并发 500 用户压测错误率 <strong className="font-semibold text-slate-800">&lt; 0.5%</strong></li>
                <li>全部 <strong className="font-semibold text-slate-800">24 个功能用例</strong> 通过</li>
                <li>通过无障碍审计（WCAG 2.1 AA）</li>
              </ul>
            </section>

            <p className="border-t border-dashed border-slate-200 pt-3 text-xs text-slate-400">
              该文档由「需求分析 Agent」根据产品沟通纪要自动生成，请核对功能范围与验收指标。
            </p>
          </div>
        </section>

        {/* 右：审批信息 */}
        <div className="space-y-4">
          <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">审批信息</h2>
            <dl className="space-y-3">
              <div className="flex items-center gap-2.5">
                <Avatar name="王五" />
                <div className="min-w-0">
                  <dt className="text-[11px] text-slate-400">提交人</dt>
                  <dd className="text-[13px] font-medium text-slate-900">王五（产品负责人）</dd>
                </div>
              </div>
              {INFO_ROWS.map((row) => (
                <div key={row.label} className="border-t border-slate-100 pt-2.5">
                  <dt className="text-[11px] text-slate-400">{row.label}</dt>
                  <dd className="text-[13px] font-medium text-slate-800">{row.value}</dd>
                  <dd className="font-mono text-[11px] text-slate-400">{row.sub}</dd>
                </div>
              ))}
              <div className="border-t border-slate-100 pt-2.5">
                <dt className="mb-1 text-[11px] text-slate-400">TTL 剩余</dt>
                <dd>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-50 px-2.5 py-0.5 text-xs font-medium text-warning-700 ring-1 ring-inset ring-warning-500/25">
                    <IconAlertCircle className="size-3.5" />
                    2 小时后超时升级
                  </span>
                </dd>
              </div>
              <div className="border-t border-slate-100 pt-2.5">
                <dt className="mb-1.5 text-[11px] text-slate-400">关联资源</dt>
                <dd className="space-y-1">
                  <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:underline">
                    <IconLink className="size-3.5" />
                    tsk-8024 客户门户改版-需求分析
                  </button>
                  <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:underline">
                    <IconLink className="size-3.5" />
                    软件公司开发流程 v3
                  </button>
                </dd>
              </div>
            </dl>
          </section>

          {/* 审批历史 */}
          <section className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">审批历史</h2>
            <ol className="space-y-0">
              {HISTORY.map((h, i) => {
                const isLast = i === HISTORY.length - 1;
                return (
                  <li key={h.round} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ${
                          h.action === "待审批"
                            ? "bg-warning-50 text-warning-600 ring-warning-500/25"
                            : h.action === "打回"
                              ? "bg-danger-50 text-danger-600 ring-danger-500/20"
                              : "bg-success-50 text-success-600 ring-success-500/20"
                        }`}
                      >
                        {h.round}
                      </span>
                      {!isLast && <span className="w-px flex-1 bg-slate-200" />}
                    </div>
                    <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-3.5"}`}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-[13px] font-medium text-slate-900">
                          {h.action === "待审批" ? `第 ${h.round} 轮 · 等待审批` : `第 ${h.round} 轮 · ${h.action}`}
                        </p>
                        {h.isCurrent && (
                          <StatusBadge tone="warning" dot={false}>当前</StatusBadge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {h.author}（{h.role}）· {h.date}
                      </p>
                      {h.comment && (
                        <p className="mt-1 rounded-[--radius-control] bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200/70">
                          {h.comment}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>

      {/* 决策区 */}
      <section className="mt-4 rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
        <div className={`flex flex-wrap items-start justify-between gap-3`}>
          <div className="min-w-0 flex-1">
            <label htmlFor="approval-comment" className="mb-1.5 block text-sm font-semibold text-slate-900">
              审批意见
            </label>
            <textarea
              id="approval-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="填写审批意见（通过时可选，驳回 / 打回时必填）…"
              className="w-full resize-none rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div className={`flex shrink-0 gap-2 ${mobile ? "w-full" : "flex-col pt-7"}`}>
            <Button className={`${mobile ? "flex-1" : ""}`}>
              <IconCheck className="size-4" />
              通过
            </Button>
            <Button variant="danger" className={`${mobile ? "flex-1" : ""}`}>
              <IconX className="size-4" />
              驳回
            </Button>
            <Button variant="outline" className={`${mobile ? "flex-1" : ""}`}>
              <IconRotateCcw className="size-4" />
              打回修改
            </Button>
          </div>
        </div>
        <p className="mt-2.5 flex items-center gap-1.5 border-t border-slate-100 pt-2.5 text-[11px] text-slate-400">
          <IconClock className="size-3.5" />
          所有审批决策将写入审计日志，并通知关联任务执行者。
        </p>
      </section>

      {/* 关联人员 */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <Avatar name="李四" size="sm" />
        <span>审批人：李四（研发总监）</span>
        <span>·</span>
        <IconUser className="size-3.5" />
        <span>抄送：陈曦、林远</span>
      </div>
    </div>
  );
}
