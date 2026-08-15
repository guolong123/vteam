import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconEdit, IconLock, IconMore, IconPlus, IconRefresh, IconSearch, StatusBadge, type Tone } from "../_shared/ui";

/**
 * 凭证（密钥）管理页原型（组：设置）
 * =====================================================
 * PC：表格（密钥值掩码显示）+ 加密提示条 + 新建凭证弹窗；
 * 移动端：表格切换为卡片。
 * 纯 UI 原型：搜索 / 弹窗开关为本地交互，无真实加解密。
 */

type SecretType = "api-key" | "token" | "oauth" | "cert";

type SecretHealth = "ok" | "expiring" | "expired";

interface Secret {
  id: string;
  name: string;
  masked: string;
  type: SecretType;
  purpose: string;
  creator: string;
  createdAt: string;
  lastUsed: string;
  health: SecretHealth;
}

const SECRETS: Secret[] = [
  { id: "sec-01", name: "openai-api-key", masked: "sk-••••••••••••", type: "api-key", purpose: "OpenAI 插件", creator: "王工", createdAt: "2026-05-12", lastUsed: "2 小时前", health: "ok" },
  { id: "sec-02", name: "github-token", masked: "ghp_••••••••••••", type: "token", purpose: "GitHub 插件", creator: "李倩", createdAt: "2026-01-20", lastUsed: "昨天 16:32", health: "ok" },
  { id: "sec-03", name: "jenkins-token", masked: "jen-••••••••••••", type: "token", purpose: "Jenkins 插件", creator: "王工", createdAt: "2026-03-08", lastUsed: "3 天前", health: "expiring" },
  { id: "sec-04", name: "gitee-token", masked: "gee-••••••••••••", type: "token", purpose: "Gitee 插件", creator: "张伟", createdAt: "2026-06-15", lastUsed: "上周", health: "ok" },
  { id: "sec-05", name: "企业微信机器人 webhook", masked: "wecom-••••••••••", type: "token", purpose: "企业微信通知插件", creator: "李倩", createdAt: "2026-04-02", lastUsed: "刚刚", health: "ok" },
  { id: "sec-06", name: "prod-db-password", masked: "••••••••••••", type: "cert", purpose: "PostgreSQL 工具（生产库）", creator: "王工", createdAt: "2025-11-30", lastUsed: "从未使用", health: "expired" },
  { id: "sec-07", name: "gitlab-oauth", masked: "gl-••••••••••••", type: "oauth", purpose: "GitLab 集成", creator: "张伟", createdAt: "2026-07-01", lastUsed: "5 天前", health: "ok" },
];

const TYPE_META: Record<SecretType, { label: string; tone: Tone }> = {
  "api-key": { label: "API Key", tone: "brand" },
  token: { label: "Token", tone: "info" },
  oauth: { label: "OAuth", tone: "warning" },
  cert: { label: "证书", tone: "neutral" },
};

const HEALTH_META: Record<SecretHealth, { text: string; tone: Tone }> = {
  ok: { text: "正常", tone: "success" },
  expiring: { text: "即将过期", tone: "warning" },
  expired: { text: "已过期", tone: "danger" },
};

/** 内联图标：钥匙（凭证标识） */
function IconKey({ className = "size-4" }: { className?: string }) {
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
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m11 12 9-9M16 7l2 2M18 5l2 2" />
    </svg>
  );
}

/** 新建凭证弹窗（纯 UI） */
function CreateSecretModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="新建凭证"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[--radius-card] border border-slate-200 bg-white shadow-frame"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <IconKey className="size-4 text-brand-600" />
            <h3 className="text-sm font-semibold text-slate-900">新建凭证</h3>
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
            <label className="mb-1.5 block text-xs font-medium text-slate-600">凭证名称</label>
            <input
              type="text"
              placeholder="如 openai-api-key"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">类型</label>
            <select
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              defaultValue="api-key"
            >
              <option value="api-key">API Key</option>
              <option value="token">Token</option>
              <option value="oauth">OAuth</option>
              <option value="cert">证书</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">凭证值</label>
            <textarea
              rows={2}
              placeholder="粘贴密钥内容…"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p className="mt-1 text-[11px] text-slate-400">保存后仅显示掩码，值不可再次查看</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-600">关联命名空间</label>
            <select
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              defaultValue="dev-team"
            >
              <option value="system">system（系统全局）</option>
              <option value="dev-team">dev-team</option>
              <option value="test-team">test-team</option>
              <option value="ops">ops</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onClose}>
            <IconPlus className="size-4" />
            保存凭证
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SecretManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const filtered = SECRETS.filter((s) => {
    const q = query.trim().toLowerCase();
    return (
      q === "" ||
      s.name.toLowerCase().includes(q) ||
      s.purpose.toLowerCase().includes(q) ||
      s.creator.toLowerCase().includes(q)
    );
  });

  const actions = (s: Secret) => (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" className="px-2 py-1 text-xs">
        <IconEdit className="size-3.5" />
        查看
      </Button>
      <Button variant="ghost" className="px-2 py-1 text-xs" disabled={s.health === "expired"}>
        <IconRefresh className="size-3.5" />
        轮换
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

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">凭证管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            共 {SECRETS.length} 条凭证 · 管理 API Key / Token 等密钥的存储与轮换
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <IconPlus className="size-4" />
          新建凭证
        </Button>
      </div>

      {/* 搜索栏 + 加密提示条 */}
      <div className="mb-4 space-y-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel">
        <div className="flex gap-2.5">
          <div className={`relative ${mobile ? "w-full" : "w-80"}`}>
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称 / 用途 / 创建人…"
              className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
        </div>
        <div className="flex items-start gap-2 rounded-[--radius-control] bg-info-50 px-3 py-2 text-xs text-info-700">
          <IconLock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            凭证使用 AES-256 加密存储，仅用于运行时注入对应插件 / Agent，任何界面均不可回显明文；建议定期轮换。
          </span>
        </div>
      </div>

      {/* 列表：PC 表格 / 移动端卡片 */}
      {mobile ? (
        <ul className="space-y-3">
          {filtered.map((s) => (
            <li
              key={s.id}
              className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
            >
              <div className="mb-2.5 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-brand-500/20">
                    <IconKey className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{s.name}</p>
                    <p className="font-mono text-[11px] text-slate-400">{s.masked}</p>
                  </div>
                </div>
                <StatusBadge tone={HEALTH_META[s.health].tone}>{HEALTH_META[s.health].text}</StatusBadge>
              </div>
              <dl className="space-y-1.5 text-xs text-slate-500">
                <div className="flex justify-between">
                  <dt>类型</dt>
                  <dd>
                    <StatusBadge tone={TYPE_META[s.type].tone} dot={false}>
                      {TYPE_META[s.type].label}
                    </StatusBadge>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>用途</dt>
                  <dd className="text-slate-700">{s.purpose}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>创建人 / 时间</dt>
                  <dd className="text-slate-700">
                    {s.creator} · {s.createdAt}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>最后使用</dt>
                  <dd className="text-slate-700">{s.lastUsed}</dd>
                </div>
              </dl>
              <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
                <Button variant="outline" className="flex-1 px-2 py-1.5 text-xs">
                  <IconEdit className="size-3.5" />
                  查看
                </Button>
                <Button variant="ghost" className="flex-1 px-2 py-1.5 text-xs" disabled={s.health === "expired"}>
                  <IconRefresh className="size-3.5" />
                  轮换
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
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">用途</th>
                <th className="px-4 py-2.5 font-medium">创建人</th>
                <th className="px-4 py-2.5 font-medium">创建时间</th>
                <th className="px-4 py-2.5 font-medium">最后使用</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="group border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-brand-500/20">
                        <IconKey className="size-4" />
                      </span>
                      <div>
                        <p className="font-medium text-slate-900">{s.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{s.masked}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={TYPE_META[s.type].tone} dot={false}>
                      {TYPE_META[s.type].label}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{s.purpose}</td>
                  <td className="px-4 py-3 text-slate-600">{s.creator}</td>
                  <td className="px-4 py-3 text-slate-500">{s.createdAt}</td>
                  <td className="px-4 py-3 text-slate-500">{s.lastUsed}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={HEALTH_META[s.health].tone}>{HEALTH_META[s.health].text}</StatusBadge>
                  </td>
                  <td className="px-4 py-3">{actions(s)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">
                    没有符合条件的凭证
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 新建凭证弹窗 */}
      {creating && <CreateSecretModal onClose={() => setCreating(false)} />}
    </div>
  );
}
