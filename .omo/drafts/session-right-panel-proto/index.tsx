/**
 * 原型：会话页右侧功能区改版（session-right-panel-v2）
 * =============================================
 * 对应改版建议：
 * - 团队 Tab：5 子页 → 2 子页（概览合并 设置+记忆；渠道保留；操作按钮上提；删除与左侧栏重复的成员列表）
 * - 任务 Tab：5 子页 → 4 子页（删除纯冗余「配置」；状态卡去掉重复队列摘要行；产出去掉重复任务详情）
 * - 有任务时默认落到「任务」；团队/任务切换保留各自子页状态
 * - 深色主题对齐当前会话页视觉
 * - 仅 import react + 原生元素 + tailwind（@proto/shared 在沙箱中为占位，不依赖）
 */
import { useState } from "react";

export const meta = {
  id: "session-right-panel-v2",
  name: "会话右侧面板改版",
  device: "desktop",
};

/* ------------------------------ 演示数据 ------------------------------ */

const TEAM = {
  name: "vteam开发团队",
  desc: "全局示例团队（e2e）",
  main: { name: "项目经理-1", role: "项目经理", initial: "P" },
  managedMode: false,
  reuseSession: true,
};

const TASK = {
  title: "流程走通测试：端到端验证建任务→计划→派活→执行→验收",
  status: "待验收",
  priority: "中",
  creator: "admin",
  createdAt: "2026-09-22 09:15",
};

const QUEUE = [
  { id: "t_0000000001", title: "流程走通测试：端到端验证…", pos: "队首", current: true },
  { id: "t_0000000002", title: "文档站原型走查", pos: "#2", current: false },
  { id: "t_0000000003", title: "权限矩阵回归", pos: "#3", current: false },
];

const ARTIFACTS = [
  { title: "端到端验证记录", type: "文档", v: "v2", accepted: true },
  { title: "最小可运行脚本", type: "文件", v: "v1", accepted: false },
  { title: "流程结论摘要", type: "结论文本", v: "v1", accepted: false },
];

const ISSUES = [
  { title: "补齐队列取消 E2E", status: "进行中", tone: "info" },
  { title: "修复 reuseSession 开关 no-op", status: "待办", tone: "warn" },
  { title: "右侧栏子页状态保留", status: "待办", tone: "muted" },
];

const TRIGGERS = [
  { title: "每日 02:00 归档检查", status: "pending", src: "系统", time: "明天 02:00" },
  { title: "验收后通知企微", status: "fired", src: "项目经理-1", time: "今天 10:02" },
  { title: "超时 30min 升级", status: "failed", src: "系统", time: "今天 09:40" },
];

/* ------------------------------ 小组件 ------------------------------ */

function Card({
  children,
  className = "",
  testid,
}: {
  children: React.ReactNode;
  className?: string;
  testid?: string;
}) {
  return (
    <div
      data-testid={testid}
      className={`rounded-xl border border-slate-700/80 bg-slate-900/70 p-3.5 ${className}`}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <span className="text-[12px] font-semibold tracking-wide text-slate-400">{children}</span>
      {extra}
    </div>
  );
}

function Toggle({ on, label, hint }: { on: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition ${
          on ? "bg-teal-600" : "bg-slate-600"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white shadow transition ${
            on ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    待验收: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
    进行中: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
    待办: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    已完成: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        map[status] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30"
      }`}
    >
      {status}
    </span>
  );
}

function SubTabs({
  items,
  active,
  onChange,
  badges = {},
  testid,
}: {
  items: { key: string; label: string }[];
  active: string;
  onChange: (k: string) => void;
  badges?: Record<string, number>;
  testid?: string;
}) {
  return (
    <div data-testid={testid} className="flex gap-0.5 border-b border-slate-700/80 px-1">
      {items.map((it) => {
        const on = it.key === active;
        const badge = badges[it.key];
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={`relative flex items-center gap-1 px-2.5 py-2 text-[12.5px] transition ${
              on ? "font-semibold text-teal-400" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {it.label}
            {badge != null && badge > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold leading-4 text-slate-950">
                {badge}
              </span>
            )}
            {on && (
              <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-teal-500" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ 团队 · 概览 ------------------------------ */

function TeamOverview({ onGoTask }: { onGoTask: () => void }) {
  const [managedMode, setManagedMode] = useState(TEAM.managedMode);
  const [resetAfterComplete, setResetAfterComplete] = useState(!TEAM.reuseSession);
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="team-overview">
      {/* 团队信息卡：仅名称 + 描述（历史任务已移至底部次级链接） */}
      <Card testid="team-info-card">
        <SectionTitle extra={<span className="text-[11px] text-slate-500">团队信息</span>}>
          {TEAM.name}
        </SectionTitle>
        <p className="text-[12px] text-slate-400">{TEAM.desc}</p>
      </Card>

      {/* 主 Agent：单行压缩，不再单独一大张卡 */}
      <Card testid="main-agent-card">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/20 text-[13px] font-bold text-sky-300 ring-1 ring-sky-500/30">
            {TEAM.main.initial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-slate-100">
                {TEAM.main.name}
              </span>
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-500/30">
                ★ 主 Agent
              </span>
            </div>
            <div className="text-[11px] text-slate-500">{TEAM.main.role}</div>
          </div>
        </div>
      </Card>

      {/* 会话设置卡：托管模式 + 完成后重置会话 两开关并排（grid-cols-2） */}
      <Card testid="team-settings-card">
        <SectionTitle extra={<span className="text-[11px] text-teal-500/80">已合并原「设置+记忆」</span>}>
          会话设置
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-lg bg-slate-800/50 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-slate-200">托管模式</span>
              <button
                type="button"
                role="switch"
                aria-checked={managedMode}
                aria-label="托管模式"
                onClick={() => setManagedMode((v) => !v)}
                className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${
                  managedMode ? "bg-teal-600" : "bg-slate-600"
                }`}
              >
                <span
                  className={`block h-4 w-4 rounded-full bg-white shadow transition ${
                    managedMode ? "translate-x-4" : ""
                  }`}
                />
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              {managedMode ? "已开启：主 Agent 自动响应" : "已关闭：@ 消息人工确认"}
            </p>
          </div>
          <div className="rounded-lg bg-slate-800/50 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-slate-200">完成后重置会话</span>
              <button
                type="button"
                role="switch"
                aria-checked={resetAfterComplete}
                aria-label="完成后重置会话"
                onClick={() => setResetAfterComplete((v) => !v)}
                className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${
                  resetAfterComplete ? "bg-teal-600" : "bg-slate-600"
                }`}
              >
                <span
                  className={`block h-4 w-4 rounded-full bg-white shadow transition ${
                    resetAfterComplete ? "translate-x-4" : ""
                  }`}
                />
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              {resetAfterComplete ? "已开启：下任务开新会话" : "已关闭：跨任务复用会话"}
            </p>
          </div>
        </div>
        {/* 记忆说明（对齐 TeamMemoryCard：团队默认保留 / 每任务新会话） */}
        <div className="mt-2.5 rounded-lg bg-slate-800/50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
          <span className="font-semibold text-teal-400">团队默认保留</span>
          ：会话跨任务复用，上下文与历史延续。
        </div>
      </Card>

      {/* 操作上提：创建任务主按钮 + 历史任务次级链接 */}
      <button
        type="button"
        data-testid="create-task-btn"
        onClick={onGoTask}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-teal-600 py-2.5 text-[13px] font-semibold text-white transition hover:bg-teal-500"
      >
        ＋ 创建任务
      </button>
      <button
        type="button"
        className="self-start text-[12px] text-teal-400 hover:text-teal-300"
      >
        历史任务 →
      </button>
      <p className="text-center text-[11px] leading-relaxed text-slate-500">
        成员管理在左侧面板
      </p>
    </div>
  );
}

/* ------------------------------ 团队 · 渠道 ------------------------------ */

function TeamChannels() {
  const channels = [
    { name: "企业微信机器人", on: true },
    { name: "钉钉群机器人", on: false },
    { name: "Webhook 回调", on: true },
  ];
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="team-channels">
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">入站</span>}>
          消息渠道
        </SectionTitle>
        <ul className="space-y-1.5">
          {channels.map((c) => (
            <li key={c.name} className="flex items-center justify-between rounded-lg bg-slate-800/50 px-2.5 py-2">
              <span className="text-[12.5px] text-slate-300">{c.name}</span>
              <span
                className={`text-[11px] ${c.on ? "text-teal-400" : "text-slate-600"}`}
              >
                {c.on ? "已绑定" : "未绑定"}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mt-2.5 w-full rounded-lg border border-slate-600 py-1.5 text-[12px] text-slate-300 hover:border-slate-500 hover:text-slate-100"
        >
          保存绑定 · 管理渠道
        </button>
      </Card>
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">出站</span>}>
          通知渠道
        </SectionTitle>
        <p className="text-[12px] text-slate-500">验收完成 / 阻塞升级时推送</p>
        <div className="mt-2 rounded-lg bg-slate-800/50 px-2.5 py-2 text-[12.5px] text-slate-300">
          企微通知机器人 <span className="ml-1 text-teal-400">已绑定</span>
        </div>
      </Card>
      <p className="text-center text-[11px] text-slate-600">渠道为一次性配置，会话中极少改动</p>
    </div>
  );
}

/* ------------------------------ 任务 · 状态 ------------------------------ */

function TaskStatus() {
  const [queue, setQueue] = useState(QUEUE);
  const waiting = queue.filter((q) => !q.current).length;
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="task-status">
      <Card testid="task-status-card">
        {/* 标题独占一行，避免被状态徽章挤窄 */}
        <h3 className="text-[13.5px] font-semibold leading-snug text-slate-100">{TASK.title}</h3>
        {/* 状态徽章 + 编辑：独立一行，编辑弱化为次级操作 */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <StatusPill status={TASK.status} />
          <button
            type="button"
            className="rounded-lg px-2.5 py-1 text-[12px] text-slate-400 transition hover:bg-slate-700/60 hover:text-slate-200"
          >
            编辑
          </button>
        </div>
        {/* 不再渲染：当前执行（队首）· 暂无等待 —— 下方队列卡已覆盖 */}
        {/* 主操作独占整行，等宽两按钮，编辑不抢宽度 */}
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            data-testid="accept-btn"
            className="rounded-xl bg-emerald-600 py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-emerald-500"
          >
            验收通过
          </button>
          <button
            type="button"
            data-testid="reject-btn"
            className="rounded-xl bg-amber-600 py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-amber-500"
          >
            驳回
          </button>
        </div>
        {/* 三行元信息：原「配置」tab 唯一有价值的字段并入此处 */}
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-dashed border-slate-700/80 pt-2.5 text-[11px]">
          <div>
            <div className="text-slate-500">优先级</div>
            <div className="mt-0.5 text-slate-300">{TASK.priority}</div>
          </div>
          <div>
            <div className="text-slate-500">创建人</div>
            <div className="mt-0.5 text-slate-300">{TASK.creator}</div>
          </div>
          <div>
            <div className="text-slate-500">创建时间</div>
            <div className="mt-0.5 text-slate-300">09-22 09:15</div>
          </div>
        </div>
      </Card>

      {/* 队列：只保留列表 + 取消，去掉与状态卡重复的头部摘要；可取消至空态 */}
      <Card testid="queue-card">
        <SectionTitle
          extra={
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 ring-1 ring-amber-500/30">
              FIFO · {waiting} 排队
            </span>
          }
        >
          团队队列
        </SectionTitle>
        <p className="mb-2 text-[11px] text-slate-500">按入队时间排序，排队中可取消（点取消可预览空态）</p>
        {queue.length === 0 ? (
          <div
            data-testid="queue-empty"
            className="rounded-lg border border-dashed border-slate-600 px-3 py-4 text-center text-[12px] leading-relaxed text-slate-500"
          >
            暂无排队任务
            <div className="mt-0.5 text-[11px]">群聊按团队复用，历史跨任务可见</div>
          </div>
        ) : (
        <ul className="space-y-1.5">
          {queue.map((q) => (
            <li
              key={q.id}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-2 ${
                q.current ? "bg-teal-500/10 ring-1 ring-teal-500/30" : "bg-slate-800/50"
              }`}
            >
              <span
                className={`shrink-0 text-[10px] font-semibold ${
                  q.current ? "text-teal-400" : "text-slate-500"
                }`}
              >
                {q.pos}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">{q.title}</span>
              {!q.current && (
                <button
                  type="button"
                  onClick={() => setQueue((prev) => prev.filter((x) => x.id !== q.id))}
                  className="shrink-0 text-[11px] text-slate-500 hover:text-rose-400"
                >
                  取消
                </button>
              )}
            </li>
          ))}
        </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------ 任务 · 计划 ------------------------------ */

function TaskPlan() {
  const steps = [
    { text: "拆解验收标准与角色分工", done: true },
    { text: "产出最小验证脚本", done: true },
    { text: "派发 Issue 至开发者 / 测试", done: false },
    { text: "汇总回执并提交验收", done: false },
  ];
  /* 计划内容聚合区：本地计划文件 + category=计划 产出物（按更新时间倒序） */
  const PLAN_FILES = [
    { name: "端到端验证计划.md", updated: "10 分钟前更新", truncated: false },
    { name: "角色分工矩阵.md", updated: "1 小时前更新", truncated: true },
  ];
  const PLAN_ARTIFACTS = [
    { title: "端到端验证记录", version: 2, accepted: true, updated: "刚刚更新" },
  ];
  type PlanMode = "content" | "loading" | "unavailable" | "empty";
  const [planMode, setPlanMode] = useState<PlanMode>("content");
  const planTotal = planMode === "content" ? PLAN_FILES.length + PLAN_ARTIFACTS.length : 0;
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="task-plan">
      <Card>
        <SectionTitle
          extra={<span className="rounded-full bg-teal-500/15 px-2 py-0.5 text-[10px] text-teal-300">执行中</span>}
        >
          计划状态
        </SectionTitle>
        <div className="flex items-center justify-between text-[12px] text-slate-400">
          <span className="font-mono">v2·R2·2/3</span>
          <span className="text-teal-400">已定稿 · 已确认执行</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full w-2/3 rounded-full bg-teal-500" />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">待 测试-1、前端-1 回执（2/3）</p>
      </Card>
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">{planTotal} 个</span>}>
          计划文档
        </SectionTitle>
        {/* 原型标注：三档空态预览（非产品 UI） */}
        <div className="mb-2 flex gap-1.5 text-[10.5px]">
          {(["content", "loading", "unavailable", "empty"] as PlanMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPlanMode(m)}
              className={`rounded-full px-2 py-0.5 ring-1 ring-inset transition ${
                planMode === m
                  ? "bg-teal-500/15 text-teal-300 ring-teal-500/30"
                  : "text-slate-500 ring-slate-700 hover:text-slate-300"
              }`}
            >
              {m === "content" ? "有内容" : m === "loading" ? "加载中" : m === "unavailable" ? "暂不可用" : "暂无内容"}
            </button>
          ))}
        </div>
        {planMode === "loading" ? (
          <div className="rounded-lg border border-slate-700 px-3 py-4 text-center text-[12px] text-slate-500">
            加载中…
          </div>
        ) : planMode === "unavailable" ? (
          <div className="rounded-lg border border-dashed border-slate-600 px-3 py-4 text-center text-[12px] text-slate-500">
            暂不可用（主 Agent 会话未建立或 worker 离线）
          </div>
        ) : planMode === "empty" ? (
          <div className="rounded-lg border border-dashed border-slate-600 px-3 py-4 text-center text-[12px] text-slate-500">
            暂无计划内容
          </div>
        ) : (
        <ul className="space-y-1.5">
          {PLAN_FILES.map((f) => (
            <li
              key={f.name}
              className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2 hover:bg-slate-800"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal-400" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-200">{f.name}</span>
                  <span className="shrink-0 whitespace-nowrap rounded-full bg-teal-500/10 px-1.5 py-px text-[10px] font-semibold text-teal-300 ring-1 ring-inset ring-teal-500/30">
                    本地文件
                  </span>
                </span>
                <span className="mt-0.5 block text-[10.5px] text-slate-500">
                  {f.updated}{f.truncated ? " · 已截断" : ""}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">›</span>
            </li>
          ))}
          {PLAN_ARTIFACTS.map((a) => (
            <li
              key={a.title}
              className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2 hover:bg-slate-800"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-200">{a.title}</span>
                  <span className="shrink-0 whitespace-nowrap rounded-full bg-blue-500/10 px-1.5 py-px text-[10px] font-semibold text-blue-300 ring-1 ring-inset ring-blue-500/30">
                    产出物 · v{a.version}
                  </span>
                </span>
                <span className="mt-0.5 block text-[10.5px] text-slate-500">
                  {a.updated}{a.accepted ? " · 已验收" : ""}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">›</span>
            </li>
          ))}
        </ul>
        )}
      </Card>
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">2/4</span>}>
          执行步骤
        </SectionTitle>
        <ol className="space-y-1.5">
          {steps.map((s, i) => (
            <li key={s.text} className="flex items-start gap-2 text-[12.5px]">
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  s.done ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700 text-slate-400"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className={s.done ? "text-slate-500 line-through" : "text-slate-300"}>
                {s.text}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

/* ------------------------------ 任务 · 产出（去掉任务详情） ------------------------------ */

function TaskOutput() {
  const typeTone: Record<string, string> = {
    文档: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
    文件: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    结论文本: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  };
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="task-output">
      {/* 不再渲染「任务详情」标题+描述 —— 与状态卡/原配置重复 */}
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">3 项</span>}>
          产出物
        </SectionTitle>
        <ul className="space-y-1.5">
          {ARTIFACTS.map((a) => (
            <li
              key={a.title}
              className="flex items-center gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${
                  typeTone[a.type] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30"
                }`}
              >
                {a.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-300">
                {a.title}
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">{a.v}</span>
              {a.accepted && (
                <span className="shrink-0 text-[11px] text-emerald-400">✓</span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">3 项</span>}>
          待办 Issue
        </SectionTitle>
        <ul className="space-y-1.5">
          {ISSUES.map((i) => (
            <li
              key={i.title}
              className="flex items-center justify-between gap-2 rounded-lg bg-slate-800/50 px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-300">
                {i.title}
              </span>
              <StatusPill status={i.status} />
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-center text-[11px] text-slate-600">
        已删除原「配置」子页 · 标题/描述/状态不再重复渲染
      </p>
    </div>
  );
}

/* ------------------------------ 任务 · 触发 ------------------------------ */

function TaskTriggers() {
  const dot: Record<string, string> = {
    pending: "bg-amber-400",
    fired: "bg-emerald-400",
    failed: "bg-rose-400",
  };
  const label: Record<string, string> = {
    pending: "待触发",
    fired: "已触发",
    failed: "失败",
  };
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="task-triggers">
      <Card>
        <SectionTitle extra={<span className="text-[11px] text-slate-500">1 待触发</span>}>
          触发器
        </SectionTitle>
        <ul className="space-y-1.5">
          {TRIGGERS.map((t) => (
            <li key={t.title} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[t.status]}`} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-slate-200">
                  {t.title}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500">{label[t.status]}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-3.5 text-[11px] text-slate-500">
                <span>{t.src}</span>
                <span>·</span>
                <span>{t.time}</span>
                {t.status === "pending" && (
                  <button type="button" className="ml-auto text-slate-400 hover:text-rose-400">
                    取消
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------ 主面板 ------------------------------ */

export default function SessionRightPanelV2() {
  const [main, setMain] = useState<"team" | "task">("task"); // 改版：有任务默认落任务
  const [teamSub, setTeamSub] = useState("overview");
  const [taskSub, setTaskSub] = useState("status");
  // 改版点：切换 主Tab 时保留各自子页状态（当前示例已用独立 state 天然保留）

  return (
    <div className="min-h-full bg-[#0b1220] text-slate-200" data-testid="right-panel-root">
      {/* 顶部设计说明条（原型标注，非产品 UI） */}
      <div className="border-b border-teal-800/50 bg-teal-950/40 px-4 py-2">
        <p className="text-[11px] leading-relaxed text-teal-300/90">
          <strong className="font-semibold">改版原型</strong>
          ：团队 5→2 子页 · 任务 5→4（删配置）· 去掉 3 处信息重复 · 成员列表下沉左侧栏 ·
          创建任务上提 · 默认落在任务
        </p>
      </div>

      {/* 模拟会话页骨架：左聊天暗示 + 右侧面板 */}
      <div className="flex min-h-[calc(100vh-36px)]">
        {/* 左侧：极简聊天区暗示（仅占位） */}
        <div className="hidden flex-1 flex-col justify-end p-6 opacity-40 md:flex">
          <div className="ml-auto max-w-md rounded-2xl rounded-br-md bg-slate-700/50 px-4 py-2.5 text-[13px] text-slate-300">
            请验收当前任务
          </div>
          <div className="mt-3 max-w-md rounded-2xl rounded-bl-md bg-slate-800 px-4 py-2.5 text-[13px] text-slate-400">
            已提交产出物，等待人工验收…
          </div>
          <p className="mt-8 text-center text-[11px] text-slate-600">← 左侧为会话区（示意）</p>
        </div>

        {/* 右侧面板（改版后） */}
        <aside
          data-testid="right-aside"
          className="flex w-full max-w-[360px] shrink-0 flex-col border-l border-slate-700/80 bg-[#0f172a] md:w-[360px]"
        >
          {/* 主 Tab */}
          <div className="flex border-b border-slate-700/80 bg-slate-950/60">
            {(
              [
                { key: "team", label: "团队" },
                { key: "task", label: "任务" },
              ] as const
            ).map((t) => {
              const on = main === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  data-testid={`main-tab-${t.key}`}
                  onClick={() => setMain(t.key)}
                  className={`flex-1 py-2.5 text-[13.5px] transition ${
                    on
                      ? "border-b-2 border-teal-500 font-semibold text-teal-400"
                      : "border-b-2 border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 内容区 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {main === "team" ? (
              <>
                <SubTabs
                  testid="team-subtabs"
                  active={teamSub}
                  onChange={setTeamSub}
                  items={[
                    { key: "overview", label: "概览" },
                    { key: "channels", label: "渠道" },
                  ]}
                />
                {teamSub === "overview" ? (
                  <TeamOverview onGoTask={() => { setMain("task"); setTaskSub("status"); }} />
                ) : (
                  <TeamChannels />
                )}
              </>
            ) : (
              <>
                <SubTabs
                  testid="task-subtabs"
                  active={taskSub}
                  onChange={setTaskSub}
                  badges={{ status: 2, output: 3, triggers: 1 }}
                  items={[
                    { key: "status", label: "状态" },
                    { key: "plan", label: "计划" },
                    { key: "output", label: "产出" },
                    { key: "triggers", label: "触发" },
                  ]}
                />
                {taskSub === "status" && <TaskStatus />}
                {taskSub === "plan" && <TaskPlan />}
                {taskSub === "output" && <TaskOutput />}
                {taskSub === "triggers" && <TaskTriggers />}
              </>
            )}
          </div>

          {/* 底部：改版 diff 提示（原型标注） */}
          <div className="border-t border-slate-800 bg-slate-950/50 px-3 py-2">
            <p className="text-[10.5px] leading-relaxed text-slate-600">
              相对现状：删「配置」子页与成员卡 · 状态卡去队列摘要行 · 产出去任务详情 ·
              设置/记忆合并 · 操作 Tab 解散
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
