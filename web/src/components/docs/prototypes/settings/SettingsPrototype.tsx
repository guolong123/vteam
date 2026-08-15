import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconRefresh, StatusBadge } from "../_shared/ui";

/**
 * 平台全局设置页原型（组：设置）
 * =====================================================
 * PC：左侧设置项导航（分组）+ 右侧内容区；移动端：顶部横向分组切换 + 单列内容。
 * 体现"插件安装后在设置中显示对应设置项"：已安装插件以分区卡片呈现。
 * 纯 UI 原型：导航 / 表单 / switch / 测试连接按钮为本地交互，无真实连接逻辑。
 */

type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

/** 内联图标（原型内自包含，stroke 风格与 _shared 一致） */
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

function IconSettings({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Icon>
  );
}

function IconServer({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="8" x="3" y="4" rx="2" />
      <rect width="18" height="8" x="3" y="12" rx="2" />
      <circle cx="7" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="7" cy="16" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconPlug({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 22v-5" />
      <path d="M9 8V2M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </Icon>
  );
}

function IconGlobe({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9Z" />
    </Icon>
  );
}

function IconBell({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Icon>
  );
}

function IconGitBranch({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v6M18 9a9 9 0 0 1-9 9" />
    </Icon>
  );
}

function IconLayers({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m12 2 8.5 4.5L12 11 3.5 6.5 12 2Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 17 8.5 4.5 8.5-4.5" />
    </Icon>
  );
}

/** 纯 UI switch 开关 */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-brand-600" : "bg-slate-200"
      }`}
    >
      <span
        className={`inline-block size-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** 表单字段共用样式 */
const inputCls =
  "w-full rounded-[--radius-control] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

const labelCls = "mb-1.5 block text-xs font-medium text-slate-600";

/** 表单字段容器 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/* ---------- 设置项导航定义 ---------- */

type SectionKey = "general" | "runtime" | "jenkins" | "github" | "gitee" | "wecom";

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
  group: "基础" | "集成";
}

const SECTIONS: SectionDef[] = [
  { key: "general", label: "通用", icon: IconSettings, group: "基础" },
  { key: "runtime", label: "运行时", icon: IconServer, group: "基础" },
  { key: "jenkins", label: "Jenkins 集成", icon: IconPlug, group: "集成" },
  { key: "github", label: "GitHub 集成", icon: IconGitBranch, group: "集成" },
  { key: "gitee", label: "Gitee 集成", icon: IconGlobe, group: "集成" },
  { key: "wecom", label: "企业微信通知", icon: IconBell, group: "集成" },
];

const GROUP_ORDER: Array<"基础" | "集成"> = ["基础", "集成"];

/** 插件分区卡片头：插件名 + 版本 + 状态 */
function PluginCardHeader({
  icon,
  name,
  version,
  tone,
  status,
}: {
  icon: ReactNode;
  name: string;
  version: string;
  tone: Tone;
  status: string;
}) {
  return (
    <header className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-brand-500/20">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">{name}</p>
        <p className="text-[11px] text-slate-400">插件版本 v{version}</p>
      </div>
      <span className="ml-auto">
        <StatusBadge tone={tone}>{status}</StatusBadge>
      </span>
    </header>
  );
}

/* ---------- 各分区内容 ---------- */

function GeneralSection() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="平台名称" hint="展示在导航栏与邮件通知署名中">
          <input type="text" defaultValue="Orchestra 任务编排平台" className={inputCls} />
        </Field>
        <Field label="默认命名空间">
          <select defaultValue="default" className={inputCls}>
            <option value="system">system（系统全局）</option>
            <option value="default">default（默认）</option>
            <option value="dev-team">dev-team</option>
            <option value="test-team">test-team</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="时区">
          <select defaultValue="Asia/Shanghai" className={inputCls}>
            <option value="Asia/Shanghai">Asia/Shanghai（UTC+8）</option>
            <option value="Asia/Tokyo">Asia/Tokyo（UTC+9）</option>
            <option value="UTC">UTC</option>
          </select>
        </Field>
        <Field label="界面语言">
          <select defaultValue="zh-CN" className={inputCls}>
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </Field>
        <Field label="审计日志保留天数" hint="到期日志自动清理，建议 ≥ 90 天">
          <input type="number" defaultValue={180} className={inputCls} />
        </Field>
      </div>
    </div>
  );
}

/* ---------- 运行时入口（完整实例管理见「运行时管理」页） ---------- */

function RuntimeSection() {
  const [isolate, setIsolate] = useState(true);
  return (
    <div className="space-y-4">
      {/* 入口卡片：跳转「运行时管理」页 */}
      <a
        href="#runtime-manage"
        className="group flex items-start justify-between gap-3 rounded-[--radius-control] border border-slate-200 bg-white p-3.5 ring-1 ring-slate-100 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-500/20">
            <IconServer className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800">运行时管理</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              管理 opencode serve 实例，Agent 创建时选择实例执行
            </p>
            <p className="mt-1 text-xs text-slate-500">3 个实例 · 2 已连接</p>
          </div>
        </div>
        <span className="mt-1 shrink-0 rounded-[--radius-control] bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition-colors group-hover:bg-brand-700">
          管理实例 →
        </span>
      </a>

      <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
        <div>
          <p className="text-sm font-medium text-slate-700">每任务工作区隔离</p>
          <p className="text-[11px] text-slate-400">每个任务在独立工作目录运行，任务结束后回收</p>
        </div>
        <Switch checked={isolate} onChange={setIsolate} label="每任务工作区隔离" />
      </div>
    </div>
  );
}

function JenkinsSection() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="服务器地址">
          <input type="text" defaultValue="http://jenkins.internal:8080" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="默认 Job 前缀">
          <input type="text" defaultValue="orchestra/" className={`${inputCls} font-mono`} />
        </Field>
      </div>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="认证 Token" hint="仅显示掩码，值不可回显">
            <input type="password" defaultValue="jen-••••••••••••" className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Button variant="outline" className="mb-5 shrink-0 px-2.5 py-1 text-xs">
          <IconRefresh className="size-3.5" />
          测试连接
        </Button>
      </div>
      <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
        <div>
          <p className="text-sm font-medium text-slate-700">启用 Jenkins 集成</p>
          <p className="text-[11px] text-slate-400">关闭后 jenkins_trigger_build 等工具对所有 Agent 不可用</p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="启用 Jenkins 集成" />
      </div>
    </div>
  );
}

function GitHubSection() {
  const [appMode, setAppMode] = useState(false);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="默认组织 / 仓库">
          <input type="text" defaultValue="xishuhq/ketaops" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Webhook 密钥">
          <input type="password" defaultValue="whsec_••••••••••••" className={`${inputCls} font-mono`} />
        </Field>
      </div>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="API Token" hint="个人访问令牌（PAT），用于 API 与 Webhook 签名校验">
            <input type="password" defaultValue="ghp_••••••••••••" className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Button variant="outline" className="mb-5 shrink-0 px-2.5 py-1 text-xs">
          <IconRefresh className="size-3.5" />
          测试连接
        </Button>
      </div>
      <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
        <div>
          <p className="text-sm font-medium text-slate-700">GitHub App 模式</p>
          <p className="text-[11px] text-slate-400">使用 App 安装凭证替代 PAT，配额更高、权限更细</p>
        </div>
        <Switch checked={appMode} onChange={setAppMode} label="GitHub App 模式" />
      </div>
    </div>
  );
}

function GiteeSection() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="space-y-4">
      <Field label="Gitee 服务地址">
        <input type="text" defaultValue="https://gitee.com/api/v5" className={`${inputCls} font-mono`} />
      </Field>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Access Token" hint="用于仓库与 PR 操作，凭证管理中可轮换">
            <input type="password" defaultValue="gee-••••••••••••" className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Button variant="outline" className="mb-5 shrink-0 px-2.5 py-1 text-xs">
          <IconRefresh className="size-3.5" />
          测试连接
        </Button>
      </div>
      <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
        <div>
          <p className="text-sm font-medium text-slate-700">启用 Gitee 集成</p>
          <p className="text-[11px] text-slate-400">校验通过后即可创建 gitee_create_pr 等工具</p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="启用 Gitee 集成" />
      </div>
    </div>
  );
}

function WecomSection() {
  const [onDone, setOnDone] = useState(true);
  const [onFail, setOnFail] = useState(true);
  const [onApproval, setOnApproval] = useState(false);
  return (
    <div className="space-y-4">
      <Field label="机器人 Webhook 地址" hint="在企业微信群中添加机器人后复制">
        <input
          type="text"
          defaultValue="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=••••••••"
          className={`${inputCls} font-mono`}
        />
      </Field>
      <div className="rounded-[--radius-control] bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="mb-2 text-xs font-medium text-slate-600">默认通知事件</p>
        <div className="space-y-2.5">
          {[
            { key: "done", label: "任务完成", checked: onDone, set: setOnDone },
            { key: "fail", label: "任务失败", checked: onFail, set: setOnFail },
            { key: "approval", label: "待审批", checked: onApproval, set: setOnApproval },
          ].map((n) => (
            <div key={n.key} className="flex items-center justify-between">
              <span className="text-sm text-slate-600">{n.label}</span>
              <Switch checked={n.checked} onChange={n.set} label={n.label} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- 主组件 ---------- */

export default function SettingsPrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [active, setActive] = useState<SectionKey>("general");

  const renderSection = () => {
    switch (active) {
      case "general":
        return <GeneralSection />;
      case "runtime":
        return <RuntimeSection />;
      case "jenkins":
        return <JenkinsSection />;
      case "github":
        return <GitHubSection />;
      case "gitee":
        return <GiteeSection />;
      case "wecom":
        return <WecomSection />;
    }
  };

  const activeMeta = SECTIONS.find((s) => s.key === active)!;
  const ActiveIcon = activeMeta.icon;

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">全局设置</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            平台与已安装插件（Jenkins / GitHub / 通知等）的运行配置
          </p>
        </div>
        <Button>
          <IconLayers className="size-4" />
          保存全部
        </Button>
      </div>

      <div className={mobile ? "" : "flex items-start gap-5"}>
        {/* 左侧设置项导航（分组） */}
        <aside className={mobile ? "mb-4" : "w-52 shrink-0"}>
          <nav className="rounded-[--radius-card] border border-slate-200 bg-white p-2 shadow-panel">
            {GROUP_ORDER.map((group) => (
              <div key={group} className={GROUP_ORDER.indexOf(group) === 0 ? "" : "mt-2 border-t border-slate-100 pt-2"}>
                <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  {group}
                </p>
                <ul className={mobile ? "flex flex-wrap gap-1" : "space-y-0.5"}>
                  {SECTIONS.filter((s) => s.group === group).map((s) => {
                    const IconOf = s.icon;
                    const on = s.key === active;
                    return (
                      <li key={s.key} className={mobile ? "" : "w-full"}>
                        <button
                          type="button"
                          onClick={() => setActive(s.key)}
                          className={`flex w-full items-center gap-2 rounded-[--radius-control] px-3 py-2 text-left text-sm transition-colors ${
                            on
                              ? "bg-brand-50 font-medium text-brand-700 ring-1 ring-inset ring-brand-500/25"
                              : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                          } ${mobile ? "min-w-max" : ""}`}
                        >
                          <IconOf className="size-4 shrink-0" />
                          {s.label}
                          {s.key === "gitee" && (
                            <StatusBadge tone="warning" dot={false} >
                              <span className="font-normal">未完成</span>
                            </StatusBadge>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <p className="mt-3 hidden text-[11px] leading-relaxed text-slate-400 sm:block">
            插件安装后自动在「集成」分组注册对应设置项，此处展示已安装插件的配置入口。
          </p>
        </aside>

        {/* 右侧内容区 */}
        <main className="min-w-0 flex-1 space-y-4">
          {/* 通用 / 运行时：普通卡片 */}
          {(active === "general" || active === "runtime") && (
            <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
              <header className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
                <ActiveIcon className="size-4 text-brand-600" />
                <h2 className="text-sm font-semibold text-slate-900">{activeMeta.label}</h2>
                <span className="ml-auto text-[11px] text-slate-400">
                  {active === "general" ? "基础平台信息" : "Agent 运行时服务连接"}
                </span>
              </header>
              <div className="p-5">{renderSection()}</div>
              <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
                <Button variant="outline">重置</Button>
                <Button>保存设置</Button>
              </footer>
            </section>
          )}

          {/* 集成：插件分区卡片（体现"插件安装后显示对应设置项"） */}
          {active !== "general" && active !== "runtime" && (
            <section className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
              <PluginCardHeader
                icon={<ActiveIcon className="size-4" />}
                name={activeMeta.label}
                version={active === "wecom" ? "1.4.2" : active === "gitee" ? "0.9.1" : "2.1.0"}
                tone={active === "gitee" ? "warning" : "success"}
                status={active === "gitee" ? "配置未完成" : "已配置"}
              />
              <div className="p-5">{renderSection()}</div>
              <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
                <Button variant="outline">恢复默认</Button>
                <Button>保存插件设置</Button>
              </footer>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
