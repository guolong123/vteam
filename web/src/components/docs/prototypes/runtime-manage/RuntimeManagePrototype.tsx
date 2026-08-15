import { useState } from "react";
import type { ReactNode } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, ProgressBar, StatusBadge } from "../_shared/ui";

/**
 * 运行时管理页原型（组：设置）
 * =====================================================
 * opencode serve 实例的完整管理页：实例列表、连接状态、健康信息、
 * 新增 / 编辑 / 删除、测试连接、默认工作区管理。
 * Agent 创建（agent-create）时选择实例并指定工作目录，本页为其管理入口。
 * 纯 UI 原型：搜索 / 展开详情 / 弹窗 / switch / 测试连接均为本地交互，无真实连接逻辑。
 */

type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

type ConnStatus = "connected" | "disconnected" | "starting";

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

function IconSearch({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  );
}

function IconPlus({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 5v14M5 12h14" />
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

function IconKey({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.3-8.3" />
      <path d="m15 8 2 2" />
      <path d="m18 5 2 2" />
    </Icon>
  );
}

function IconFolder({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  );
}

function IconRefresh({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  );
}

function IconEdit({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </Icon>
  );
}

function IconTrash({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  );
}

function IconX({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

function IconChevronDown({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

function IconChevronUp({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

function IconTerminal({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </Icon>
  );
}

function IconActivity({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Icon>
  );
}

function IconCpu({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </Icon>
  );
}

function IconBot({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 4v4M8 4h8" />
      <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

function IconLogs({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8M8 9h2" />
    </Icon>
  );
}

function IconExternalLink({ className = "size-4" }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
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

/* ---------- 数据 ---------- */

interface RuntimeInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  status: ConnStatus;
  authMode: "basic" | "none";
  authUser: string;
  authPasswordMask: string;
  defaultWorkspace: string;
  version: string;
  sessions: number;
  agentRefs: number;
  cpu: number | null;
  memory: number | null;
  enabled: boolean;
  lastPing: string;
}

interface Session {
  id: string;
  task: string;
  startedAt: string;
}

const INITIAL_INSTANCES: RuntimeInstance[] = [
  {
    id: "opencode-dev",
    name: "opencode-dev",
    host: "127.0.0.1",
    port: 4096,
    status: "connected",
    authMode: "basic",
    authUser: "admin",
    authPasswordMask: "••••••••",
    defaultWorkspace: "/workspaces/opencode-dev",
    version: "0.7.4",
    sessions: 3,
    agentRefs: 3,
    cpu: 32,
    memory: 58,
    enabled: true,
    lastPing: "刚刚",
  },
  {
    id: "opencode-cicd",
    name: "opencode-cicd",
    host: "10.0.0.5",
    port: 4096,
    status: "connected",
    authMode: "none",
    authUser: "",
    authPasswordMask: "",
    defaultWorkspace: "/workspaces/opencode-cicd",
    version: "0.7.3",
    sessions: 1,
    agentRefs: 2,
    cpu: 18,
    memory: 41,
    enabled: true,
    lastPing: "3 分钟前",
  },
  {
    id: "opencode-prod",
    name: "opencode-prod",
    host: "10.0.0.9",
    port: 4096,
    status: "disconnected",
    authMode: "basic",
    authUser: "operator",
    authPasswordMask: "••••••••",
    defaultWorkspace: "/workspaces/opencode-prod",
    version: "—",
    sessions: 0,
    agentRefs: 1,
    cpu: null,
    memory: null,
    enabled: true,
    lastPing: "1 小时前",
  },
];

/** 每实例会话示例（纯 UI，非真实会话） */
const SESSION_MAP: Record<string, Session[]> = {
  "opencode-dev": [
    { id: "ses_8f2a91", task: "T-0831 · 需求分析", startedAt: "09:12" },
    { id: "ses_7c0b42", task: "T-0829 · 代码评审", startedAt: "08:47" },
    { id: "ses_3d1e08", task: "T-0827 · 测试用例生成", startedAt: "昨日 18:02" },
  ],
  "opencode-cicd": [{ id: "ses_5a94c7", task: "T-0826 · 发布检查", startedAt: "10:03" }],
  "opencode-prod": [],
};

const EMPTY_FORM = {
  name: "",
  host: "",
  port: "4096",
  authMode: "basic" as "basic" | "none",
  authUser: "",
  authPassword: "",
  defaultWorkspace: "",
  enabled: true,
};

/** 浏览弹层中的常用路径（模拟，非真实文件系统） */
const COMMON_DIRS = [
  "/workspaces/opencode-dev",
  "/workspaces/opencode-cicd",
  "/data/projects/repo-a",
  "/data/projects/repo-b",
  "/home/dev/app",
  "/tmp/sandbox",
];

function statusTone(status: ConnStatus): Tone {
  if (status === "connected") return "success";
  if (status === "starting") return "warning";
  return "danger";
}

function statusLabel(status: ConnStatus): string {
  if (status === "connected") return "已连接";
  if (status === "starting") return "启动中";
  return "未连接";
}

/* ---------- 主组件 ---------- */

export default function RuntimeManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";

  const [instances, setInstances] = useState<RuntimeInstance[]>(INITIAL_INSTANCES);
  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RuntimeInstance | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dirPicker, setDirPicker] = useState(false);
  const [deleting, setDeleting] = useState<RuntimeInstance | null>(null);

  const patchForm = (patch: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...patch }));

  const filtered = instances.filter(
    (i) =>
      i.name.toLowerCase().includes(query.toLowerCase()) ||
      `${i.host}:${i.port}`.includes(query.toLowerCase()),
  );

  const totalSessions = instances.reduce((acc, i) => acc + i.sessions, 0);
  const connectedCount = instances.filter((i) => i.status === "connected").length;

  const testConnection = (id: string) => {
    setTesting((t) => ({ ...t, [id]: true }));
    window.setTimeout(() => {
      setTesting((t) => ({ ...t, [id]: false }));
      setInstances((list) =>
        list.map((i) =>
          i.id === id
            ? { ...i, status: "connected" as ConnStatus, lastPing: "刚刚" }
            : i,
        ),
      );
    }, 900);
  };

  const toggleEnabled = (id: string) => {
    setInstances((list) =>
      list.map((i) => (i.id === id ? { ...i, enabled: !i.enabled } : i)),
    );
  };

  const toggleExpanded = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (inst: RuntimeInstance) => {
    setEditing(inst);
    setForm({
      name: inst.name,
      host: inst.host,
      port: String(inst.port),
      authMode: inst.authMode,
      authUser: inst.authUser,
      authPassword: inst.authPasswordMask,
      defaultWorkspace: inst.defaultWorkspace,
      enabled: inst.enabled,
    });
    setFormOpen(true);
  };

  const saveForm = () => {
    if (editing) {
      setInstances((list) =>
        list.map((i) =>
          i.id === editing.id
            ? {
                ...i,
                name: form.name,
                host: form.host,
                port: Number(form.port) || 4096,
                authMode: form.authMode,
                authUser: form.authUser,
                authPasswordMask: form.authPassword ? "••••••••" : i.authPasswordMask,
                defaultWorkspace: form.defaultWorkspace,
                enabled: form.enabled,
              }
            : i,
        ),
      );
    } else {
      const name = form.name || `opencode-${instances.length + 1}`;
      const inst: RuntimeInstance = {
        id: `opencode-${instances.length + 1}`,
        name,
        host: form.host || "127.0.0.1",
        port: Number(form.port) || 4096,
        status: "starting",
        authMode: form.authMode,
        authUser: form.authUser,
        authPasswordMask: form.authPassword ? "••••••••" : "",
        defaultWorkspace: form.defaultWorkspace || `/workspaces/${name}`,
        version: "—",
        sessions: 0,
        agentRefs: 0,
        cpu: null,
        memory: null,
        enabled: form.enabled,
        lastPing: "刚刚注册",
      };
      setInstances((list) => [...list, inst]);
    }
    setFormOpen(false);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    setInstances((list) => list.filter((i) => i.id !== deleting.id));
    setDeleting(null);
  };

  /* 统计条 */
  const stats = [
    { label: "实例总数", value: String(instances.length), icon: IconServer, tone: "text-brand-600 bg-brand-50 ring-brand-500/20" },
    { label: "已连接", value: String(connectedCount), icon: IconActivity, tone: "text-success-600 bg-success-50 ring-success-500/20" },
    { label: "活跃会话数", value: String(totalSessions), icon: IconTerminal, tone: "text-info-600 bg-info-50 ring-info-500/20" },
  ];

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">运行时管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            管理 opencode serve 实例，Agent 创建时选择实例并指定工作目录执行
          </p>
        </div>
        <Button onClick={openCreate}>
          <IconPlus className="size-4" />
          新增实例
        </Button>
      </div>

      {/* 统计条 */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        {stats.map((s) => {
          const SIcon = s.icon;
          return (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-[--radius-card] border border-slate-200 bg-white p-3.5 shadow-panel sm:p-4"
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] ring-1 ring-inset ${s.tone}`}
              >
                <SIcon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold leading-tight text-slate-900 sm:text-xl">
                  {s.value}
                </p>
                <p className="truncate text-[11px] text-slate-400">{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* 搜索条 */}
      <div className="mb-4">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索实例名称或地址…"
            className={`${inputCls} pl-9`}
          />
        </div>
      </div>

      {/* 实例列表 */}
      {filtered.length === 0 ? (
        <div className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white p-10 text-center shadow-panel">
          <IconServer className="mx-auto size-8 text-slate-300" />
          <p className="mt-2 text-sm font-medium text-slate-600">未找到匹配的实例</p>
          <p className="mt-0.5 text-xs text-slate-400">尝试调整搜索关键词，或新增一个 opencode serve 实例</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((inst) => {
            const isOpen = !!expanded[inst.id];
            const sessions = SESSION_MAP[inst.id] ?? [];
            return (
              <div
                key={inst.id}
                className="rounded-[--radius-card] border border-slate-200 bg-white shadow-panel transition-shadow hover:shadow-lg"
              >
                {/* 卡片头：名称 + 状态 + 开关 + 展开 */}
                <div className="flex items-start gap-2.5 px-4 pt-4 sm:px-5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-control] bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-500/20">
                    <IconServer className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate font-mono text-sm font-semibold text-slate-800">{inst.name}</p>
                      <StatusBadge tone={statusTone(inst.status)}>{statusLabel(inst.status)}</StatusBadge>
                      {!inst.enabled && (
                        <StatusBadge tone="neutral" dot={false}>
                          已停用
                        </StatusBadge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
                      http://{inst.host}:{inst.port}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={inst.enabled}
                      onChange={() => toggleEnabled(inst.id)}
                      label={`启用 ${inst.name}`}
                    />
                    <button
                      type="button"
                      aria-label={isOpen ? `收起 ${inst.name} 详情` : `展开 ${inst.name} 详情`}
                      onClick={() => toggleExpanded(inst.id)}
                      className="rounded-[--radius-control] p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600"
                    >
                      {isOpen ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
                    </button>
                  </div>
                </div>

                {/* 健康信息 */}
                <div className="grid grid-cols-3 gap-x-4 gap-y-2 border-b border-slate-100 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-400">opencode</p>
                    <p className="mt-0.5 truncate font-mono text-xs font-medium text-slate-700">v{inst.version}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-400">活跃会话</p>
                    <p className="mt-0.5 font-mono text-xs font-medium text-slate-700">{inst.sessions}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-400">Agent 引用</p>
                    <p className="mt-0.5 font-mono text-xs font-medium text-slate-700">{inst.agentRefs}</p>
                  </div>
                </div>

                {/* 详情信息 */}
                <div className="space-y-2.5 px-4 py-3 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-400">
                      <IconKey className="size-3" />
                      认证
                    </span>
                    <span className="min-w-0 truncate text-xs text-slate-600">
                      {inst.authMode === "basic" ? (
                        <span className="flex items-center gap-1">
                          <span className="font-medium text-slate-700">Basic Auth</span>
                          <span className="truncate font-mono text-slate-400">
                            {inst.authUser} / {inst.authPasswordMask}
                          </span>
                        </span>
                      ) : (
                        "无"
                      )}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-400">
                      <IconFolder className="size-3" />
                      默认工作区
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs text-slate-600">
                      {inst.defaultWorkspace}
                    </span>
                  </div>

                  {inst.status === "connected" && inst.cpu !== null && inst.memory !== null && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-0.5">
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1 text-[11px] text-slate-400">
                            <IconCpu className="size-3" />
                            CPU
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">{inst.cpu}%</span>
                        </div>
                        <ProgressBar value={inst.cpu} tone={inst.cpu > 80 ? "danger" : "brand"} />
                      </div>
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[11px] text-slate-400">内存</span>
                          <span className="font-mono text-[11px] text-slate-500">{inst.memory}%</span>
                        </div>
                        <ProgressBar value={inst.memory} tone="success" />
                      </div>
                    </div>
                  )}
                </div>

                {/* 操作区 */}
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
                  <Button
                    variant="outline"
                    className="px-2.5 py-1 text-xs"
                    disabled={!!testing[inst.id] || inst.status === "starting"}
                    onClick={() => testConnection(inst.id)}
                  >
                    <IconRefresh className={`size-3.5 ${testing[inst.id] ? "animate-spin" : ""}`} />
                    {testing[inst.id] ? "测试中…" : "测试连接"}
                  </Button>
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`编辑 ${inst.name}`}
                      onClick={() => openEdit(inst)}
                      className="rounded-[--radius-control] p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600"
                    >
                      <IconEdit className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${inst.name}`}
                      onClick={() => setDeleting(inst)}
                      className="rounded-[--radius-control] p-1.5 text-slate-400 transition-colors hover:bg-danger-50 hover:text-danger-600"
                    >
                      <IconTrash className="size-4" />
                    </button>
                  </span>
                </div>

                {/* 展开详情：会话 + Agent 引用 + 日志入口 */}
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3.5 sm:px-5">
                    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      <IconTerminal className="size-3" />
                      活跃会话（{sessions.length}）
                    </p>
                    {sessions.length === 0 ? (
                      <p className="rounded-[--radius-control] border border-dashed border-slate-200 bg-white px-3 py-2 text-xs text-slate-400">
                        当前无活跃会话，任务提交后将在此显示
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {sessions.map((s) => (
                          <li
                            key={s.id}
                            className="flex items-center gap-2 rounded-[--radius-control] bg-white px-3 py-2 ring-1 ring-slate-200"
                          >
                            <span className="size-1.5 shrink-0 rounded-full bg-success-500" />
                            <span className="font-mono text-xs font-medium text-slate-700">{s.id}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{s.task}</span>
                            <span className="shrink-0 text-[11px] text-slate-400">{s.startedAt}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs text-slate-500">
                        <IconBot className="size-3.5 text-slate-400" />
                        被 <span className="font-semibold text-slate-700">{inst.agentRefs}</span> 个 Agent 引用
                        <a
                          href="#agent-list"
                          className="font-medium text-brand-600 transition-colors hover:text-brand-700"
                        >
                          查看
                        </a>
                      </span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700"
                      >
                        <IconLogs className="size-3.5" />
                        查看运行日志
                        <IconExternalLink className="size-3" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-[11px] text-slate-400">
        健康数据（CPU / 内存 / 活跃会话）来自实例健康检查接口的最近一次上报；未连接实例不采集。
      </p>

      {/* 新增 / 编辑实例弹窗 */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setFormOpen(false)}
        >
          <div
            className={`overflow-y-auto bg-white shadow-panel ${
              mobile
                ? "h-full w-full rounded-none"
                : "max-h-[90vh] w-full max-w-md rounded-[--radius-card]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
              <IconServer className="size-4 text-brand-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                {editing ? "编辑 opencode 实例" : "新增 opencode 实例"}
              </h3>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setFormOpen(false)}
                className="ml-auto rounded-[--radius-control] p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <IconX className="size-4" />
              </button>
            </header>
            <div className="space-y-4 p-5">
              <Field label="实例名">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => patchForm({ name: e.target.value })}
                  placeholder="opencode-dev"
                  className={`${inputCls} font-mono`}
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Field label="地址" hint="主机名或 IP，不含协议前缀">
                    <input
                      type="text"
                      value={form.host}
                      onChange={(e) => patchForm({ host: e.target.value })}
                      placeholder="127.0.0.1"
                      className={`${inputCls} font-mono`}
                    />
                  </Field>
                </div>
                <Field label="端口">
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => patchForm({ port: e.target.value })}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="认证方式">
                <select
                  value={form.authMode}
                  onChange={(e) =>
                    patchForm({ authMode: e.target.value === "none" ? "none" : "basic" })
                  }
                  className={inputCls}
                >
                  <option value="basic">Basic Auth（用户名 + 密码）</option>
                  <option value="none">不启用认证（仅内网环境）</option>
                </select>
              </Field>
              {form.authMode === "basic" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="用户名">
                    <input
                      type="text"
                      value={form.authUser}
                      onChange={(e) => patchForm({ authUser: e.target.value })}
                      placeholder="admin"
                      className={inputCls}
                    />
                  </Field>
                  <Field label="密码" hint="编辑时留空保持原密码">
                    <input
                      type="password"
                      value={form.authPassword}
                      onChange={(e) => patchForm({ authPassword: e.target.value })}
                      placeholder="••••••••"
                      className={`${inputCls} font-mono`}
                    />
                  </Field>
                </div>
              )}
              <Field label="默认工作区路径" hint="Agent 未单独设置工作目录时使用">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.defaultWorkspace}
                    onChange={(e) => patchForm({ defaultWorkspace: e.target.value })}
                    placeholder="/workspaces/opencode-dev"
                    className={`${inputCls} min-w-0 flex-1 font-mono`}
                  />
                  <Button variant="outline" className="shrink-0" onClick={() => setDirPicker(true)}>
                    <IconFolder className="size-3.5" />
                    浏览
                  </Button>
                </div>
              </Field>
              <div className="flex items-center justify-between rounded-[--radius-control] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
                <div>
                  <p className="text-sm font-medium text-slate-700">启用实例</p>
                  <p className="text-[11px] text-slate-400">停用后 Agent 创建时不可选择该实例</p>
                </div>
                <Switch checked={form.enabled} onChange={(v) => patchForm({ enabled: v })} label="启用实例" />
              </div>
            </div>
            <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                取消
              </Button>
              <Button onClick={saveForm}>{editing ? "保存修改" : "创建实例"}</Button>
            </footer>
          </div>
        </div>
      )}

      {/* 工作目录浏览弹层（模拟，非真实文件系统） */}
      {dirPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDirPicker(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-[--radius-card] bg-white shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <IconFolder className="size-4 text-brand-600" />
              <h3 className="text-sm font-semibold text-slate-900">选择默认工作区</h3>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setDirPicker(false)}
                className="ml-auto rounded-[--radius-control] p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <IconX className="size-4" />
              </button>
            </header>
            <div className="p-3">
              <p className="mb-2 px-1 text-[11px] text-slate-400">常用路径（模拟，非真实文件系统）</p>
              <ul className="space-y-1">
                {[
                  form.defaultWorkspace,
                  ...COMMON_DIRS.filter((p) => p !== form.defaultWorkspace),
                ]
                  .filter(Boolean)
                  .map((p) => (
                    <li key={p}>
                      <button
                        type="button"
                        onClick={() => {
                          patchForm({ defaultWorkspace: p });
                          setDirPicker(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-[--radius-control] px-2.5 py-2 text-left font-mono text-xs transition-colors ${
                          p === form.defaultWorkspace
                            ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-500/25"
                            : "text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <IconFolder className="size-3.5 shrink-0 text-slate-400" />
                        <span className="min-w-0 truncate">{p}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
            <footer className="flex justify-end border-t border-slate-100 px-4 py-2.5">
              <Button variant="ghost" onClick={() => setDirPicker(false)}>
                取消
              </Button>
            </footer>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDeleting(null)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-[--radius-card] bg-white shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-50 text-danger-600">
                <IconTrash className="size-4" />
              </span>
              <h3 className="text-sm font-semibold text-slate-900">删除实例</h3>
            </header>
            <div className="px-5 py-4">
              <p className="text-sm leading-relaxed text-slate-600">
                确定删除 opencode 实例{" "}
                <span className="font-mono font-semibold text-slate-800">{deleting.name}</span>{" "}
                吗？
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                被 <span className="font-medium text-slate-500">{deleting.agentRefs}</span>{" "}
                个 Agent 引用的实例删除后，这些 Agent 将无法继续调度，且该操作不可恢复。
              </p>
            </div>
            <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
              <Button variant="outline" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="danger" onClick={confirmDelete}>
                确认删除
              </Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
