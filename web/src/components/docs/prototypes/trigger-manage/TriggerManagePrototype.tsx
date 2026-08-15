import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconClock, IconEdit, IconMore, IconPlus, StatusBadge } from "../_shared/ui";

/**
 * 触发器配置页原型（组：任务）
 * =====================================================
 * 管理两类触发器：定时触发（cron）与 Webhook 触发。
 * PC：类型 tab + 表格；移动端：tab 保留、表格转卡片。
 * 纯 UI 原型：tab / switch / 新建弹窗为本地交互。
 */

interface CronTrigger {
  id: string;
  name: string;
  flow: string;
  cron: string;
  next: string;
  enabled: boolean;
}

interface WebhookTrigger {
  id: string;
  name: string;
  flow: string;
  path: string;
  signed: boolean;
  lastTriggered: string;
  enabled: boolean;
}

const CRON_TRIGGERS: CronTrigger[] = [
  { id: "cron-01", name: "工作日晨会需求同步", flow: "软件公司开发流程", cron: "0 9 * * 1-5", next: "2026-08-04 09:00", enabled: true },
  { id: "cron-02", name: "每日代码质量扫描", flow: "代码质量检查流程", cron: "0 18 * * *", next: "2026-08-03 18:00", enabled: true },
  { id: "cron-03", name: "每小时数据采集", flow: "数据采集流水线", cron: "0 * * * *", next: "2026-08-03 15:00", enabled: true },
  { id: "cron-04", name: "每周环境清理", flow: "环境治理流程", cron: "0 2 * * 0", next: "2026-08-09 02:00", enabled: false },
  { id: "cron-05", name: "月度账单汇总", flow: "财务汇总流程", cron: "0 8 1 * *", next: "2026-09-01 08:00", enabled: true },
];

const WEBHOOK_TRIGGERS: WebhookTrigger[] = [
  { id: "wh-01", name: "GitHub Issue 触发", flow: "需求流转流程", path: "/webhooks/github-issue", signed: true, lastTriggered: "12 分钟前", enabled: true },
  { id: "wh-02", name: "Jenkins 构建完成回调", flow: "发布流水线", path: "/webhooks/jenkins-build", signed: true, lastTriggered: "1 小时前", enabled: true },
  { id: "wh-03", name: "企业微信指令触发", flow: "工单处理流程", path: "/webhooks/wecom-command", signed: false, lastTriggered: "3 天前", enabled: true },
];

/** 开关（纯 UI，可点击切换） */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-brand-600" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** 内联图标：闪电（Webhook / 触发） */
function IconBolt({ className = "size-4" }: { className?: string }) {
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
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}

/** 新建触发器弹窗（纯 UI） */
function CreateTriggerModal({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<"cron" | "webhook">("cron");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="新建触发器"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[--radius-card] border border-slate-200 bg-white shadow-frame"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <IconBolt className="size-4 text-brand-600" />
            <h3 className="text-sm font-semibold text-slate-900">新建触发器</h3>
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
            <label className="mb-1.5 block text-xs font-medium text-slate-600">触发类型</label>
            <div className="flex gap-2">
              {(
                [
                  { value: "cron", label: "定时触发（cron）" },
                  { value: "webhook", label: "Webhook 触发" },
                ] as const
              ).map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setKind(t.value)}
                  className={`flex-1 rounded-[--radius-control] border px-3 py-2 text-sm transition-colors ${
                    kind === t.value
                      ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">触发器名称</label>
            <input
              type="text"
              placeholder="如 每日代码质量扫描"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">关联流程</label>
            <select
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              defaultValue="flow-dev"
            >
              <option value="flow-dev">软件公司开发流程</option>
              <option value="flow-quality">代码质量检查流程</option>
              <option value="flow-collect">数据采集流水线</option>
              <option value="flow-release">发布流水线</option>
            </select>
          </div>
          {kind === "cron" ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Cron 表达式</label>
              <input
                type="text"
                placeholder="如 0 9 * * 1-5"
                className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <p className="mt-1 text-[11px] text-slate-400">分 时 日 月 周，支持 */范围与逗号列表</p>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-600">Webhook 路径</label>
              <input
                type="text"
                placeholder="如 /webhooks/github-issue"
                className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <div className="mt-3">
                <label className="mb-1.5 block text-xs font-medium text-slate-600">签名密钥</label>
                <input
                  type="text"
                  placeholder="留空则回调不校验签名"
                  className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onClose}>
            <IconPlus className="size-4" />
            创建触发器
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function TriggerManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [tab, setTab] = useState<"cron" | "webhook">("cron");
  const [creating, setCreating] = useState(false);
  const [cronOn, setCronOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CRON_TRIGGERS.map((t) => [t.id, t.enabled])),
  );
  const [webhookOn, setWebhookOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(WEBHOOK_TRIGGERS.map((t) => [t.id, t.enabled])),
  );

  const activeCount = tab === "cron" ? CRON_TRIGGERS.length : WEBHOOK_TRIGGERS.length;

  /* ---------- 定时触发 tab ---------- */
  const cronBody = mobile ? (
    <ul className="space-y-3">
      {CRON_TRIGGERS.map((t) => (
        <li key={t.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-info-50 text-info-600 ring-1 ring-info-500/20">
                <IconClock className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{t.name}</p>
                <p className="truncate text-[11px] text-slate-400">{t.flow}</p>
              </div>
            </div>
            <Switch
              checked={cronOn[t.id]}
              onChange={(v) => setCronOn((prev) => ({ ...prev, [t.id]: v }))}
              label={`${t.name} 启用状态`}
            />
          </div>
          <dl className="space-y-1.5 text-xs text-slate-500">
            <div className="flex justify-between">
              <dt>Cron</dt>
              <dd className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{t.cron}</dd>
            </div>
            <div className="flex justify-between">
              <dt>下次触发</dt>
              <dd className="font-mono text-slate-700">{t.next}</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
            <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
              <IconEdit className="size-3.5" />
              编辑
            </Button>
            <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs text-danger-600 hover:bg-danger-50">
              删除
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
            <th className="px-4 py-2.5 font-medium">名称</th>
            <th className="px-4 py-2.5 font-medium">关联流程</th>
            <th className="px-4 py-2.5 font-medium">Cron 表达式</th>
            <th className="px-4 py-2.5 font-medium">下次触发时间</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {CRON_TRIGGERS.map((t) => (
            <tr key={t.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] bg-info-50 text-info-600 ring-1 ring-info-500/20">
                    <IconClock className="size-4" />
                  </span>
                  <p className="font-medium text-slate-900">{t.name}</p>
                </div>
              </td>
              <td className="px-4 py-3 text-slate-600">{t.flow}</td>
              <td className="px-4 py-3">
                <code className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-brand-700">{t.cron}</code>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-600">{t.next}</td>
              <td className="px-4 py-3">
                <Switch
                  checked={cronOn[t.id]}
                  onChange={(v) => setCronOn((prev) => ({ ...prev, [t.id]: v }))}
                  label={`${t.name} 启用状态`}
                />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" className="px-2 py-1 text-xs">
                    <IconEdit className="size-3.5" />
                    编辑
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs text-danger-600 hover:bg-danger-50">
                    删除
                  </Button>
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label="更多操作"
                  >
                    <IconMore className="size-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  /* ---------- Webhook 触发 tab ---------- */
  const webhookBody = mobile ? (
    <ul className="space-y-3">
      {WEBHOOK_TRIGGERS.map((t) => (
        <li key={t.id} className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-warning-50 text-warning-600 ring-1 ring-warning-500/25">
                <IconBolt className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{t.name}</p>
                <p className="truncate text-[11px] text-slate-400">{t.flow}</p>
              </div>
            </div>
            <Switch
              checked={webhookOn[t.id]}
              onChange={(v) => setWebhookOn((prev) => ({ ...prev, [t.id]: v }))}
              label={`${t.name} 启用状态`}
            />
          </div>
          <dl className="space-y-1.5 text-xs text-slate-500">
            <div className="flex justify-between">
              <dt>路径</dt>
              <dd className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{t.path}</dd>
            </div>
            <div className="flex justify-between">
              <dt>签名</dt>
              <dd>
                <StatusBadge tone={t.signed ? "success" : "warning"}>{t.signed ? "已配置签名" : "未签名"}</StatusBadge>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>最近触发</dt>
              <dd className="text-slate-700">{t.lastTriggered}</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
            <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
              <IconEdit className="size-3.5" />
              编辑
            </Button>
            <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs text-danger-600 hover:bg-danger-50">
              删除
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
            <th className="px-4 py-2.5 font-medium">名称</th>
            <th className="px-4 py-2.5 font-medium">关联流程</th>
            <th className="px-4 py-2.5 font-medium">路径</th>
            <th className="px-4 py-2.5 font-medium">签名状态</th>
            <th className="px-4 py-2.5 font-medium">最近触发</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {WEBHOOK_TRIGGERS.map((t) => (
            <tr key={t.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] bg-warning-50 text-warning-600 ring-1 ring-warning-500/25">
                    <IconBolt className="size-4" />
                  </span>
                  <p className="font-medium text-slate-900">{t.name}</p>
                </div>
              </td>
              <td className="px-4 py-3 text-slate-600">{t.flow}</td>
              <td className="px-4 py-3">
                <code className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-brand-700">{t.path}</code>
              </td>
              <td className="px-4 py-3">
                <StatusBadge tone={t.signed ? "success" : "warning"}>{t.signed ? "已配置签名" : "未签名"}</StatusBadge>
              </td>
              <td className="px-4 py-3 text-slate-500">{t.lastTriggered}</td>
              <td className="px-4 py-3">
                <Switch
                  checked={webhookOn[t.id]}
                  onChange={(v) => setWebhookOn((prev) => ({ ...prev, [t.id]: v }))}
                  label={`${t.name} 启用状态`}
                />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" className="px-2 py-1 text-xs">
                    <IconEdit className="size-3.5" />
                    编辑
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-xs text-danger-600 hover:bg-danger-50">
                    删除
                  </Button>
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    aria-label="更多操作"
                  >
                    <IconMore className="size-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">触发器配置</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            定时（cron）与 Webhook 两类触发器 · 共 {CRON_TRIGGERS.length + WEBHOOK_TRIGGERS.length} 个
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <IconPlus className="size-4" />
          新建触发器
        </Button>
      </div>

      {/* 类型 tab */}
      <div className="mb-4 flex items-center gap-1 rounded-[--radius-control] border border-slate-200 bg-white p-1 shadow-panel sm:w-fit">
        {(
          [
            { value: "cron", label: "定时触发", count: CRON_TRIGGERS.length },
            { value: "webhook", label: "Webhook 触发", count: WEBHOOK_TRIGGERS.length },
          ] as const
        ).map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`flex-1 whitespace-nowrap rounded-[--radius-control] px-4 py-1.5 text-sm transition-colors sm:flex-none ${
              tab === t.value
                ? "bg-brand-600 font-medium text-white"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-[11px] ${tab === t.value ? "text-brand-100" : "text-slate-400"}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {tab === "cron"
            ? "定时表达式按服务器时区（Asia/Shanghai）执行"
            : "Webhook 回调需在网关配置签名校验"}
        </p>
        <p className="text-xs text-slate-400">共 {activeCount} 个触发器</p>
      </div>
      {tab === "cron" ? cronBody : webhookBody}

      {/* 新建触发器弹窗 */}
      {creating && <CreateTriggerModal onClose={() => setCreating(false)} />}
    </div>
  );
}
