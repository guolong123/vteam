/**
 * 原型：微信式会话页（wechat-chat）· 成员 / 群聊统一会话中心
 * ============================================================
 * 背景：成员从「群聊(Team)」解耦为平台级资产（可先建成员、建群时从成员库选、
 * 一个成员可加入多个群聊），因此会话页不再是「团队页 + 成员面板」，而是微信式
 * 的单一会话列表：成员会话与群聊会话平铺在左栏，用类型徽章区分。
 *
 * 布局（三栏，桌面 1280×800 DeviceFrame 内）：
 * - 左栏 300：搜索 + 新建群聊 + 全部/群聊/成员筛选 + 置顶分组 + 平铺会话条目
 *   （头像 / 名称 / 「群」「成员」徽章 / 最后一条消息摘要 / 时间 / 未读红点）。
 * - 中栏 flex：群聊态 = 群头部（群名 + 人数 + 操作）+ **成员切换条**（全部 + 各成员，
 *   点击切换「正在看谁」并过滤消息流）+ 消息流 + @ 提示输入区；
 *   私聊态 = 成员信息头部（头像 / 名称 / 角色 / 状态 / 对话入口，**无成员切换条**）+ 消息流。
 * - 右栏 288：群聊态 = 任务 / 成员 / 产出 三 Tab；私聊态 = 该成员信息卡
 *   （绑定 Agent / 模型 / worker / 工作目录 / 技能 / 最近任务 / 操作按钮）。
 *
 * 关键设计意图（供评审）：
 * - 全局会话（新版设计 §3.5，产品已拍板）：**一个成员全局只有一个 session**，跨群共享
 *   上下文、不做会话隔离。因此私聊头部只展示一行**只读**的全局会话信息（含「最近活跃群」，
 *   不可切换、不参与路由）；右栏成员卡提供「重置全局会话」（二次确认，影响该成员在所有
 *   群聊的上下文）。
 * - 群聊态额外表达「成员在别的群忙」：成员切换条打忙碌标 + 消息流上方一条**信息态**提示条
 *   + 发送后的「已送达」toast。v1.2 起**取消排队/流控**：A/B 群随时可 @，消息一律送达，
 *   不显示排队位次/上限，由成员自行安排先后。
 * - 双工作目录（设计 §3.6.4 / D3）：团队/席位目录（团队上下文执行时**以团队目录为准**）
 *   与成员私有目录（个人工作台）分开展示，私聊右栏与成员库抽屉都拆成两行。
 * - 注入提示不进 UI（v1.3）：来源群 / 上下文分界 / 工作目录等提示只进入模型上下文，
 *   群聊与私聊窗口只显示用户实际发送的内容，气泡与元信息上不暴露任何自动注入的提示。
 * - 默认工作目录（v1.3）：会话默认 cwd = 成员**私有目录**；团队目录是「可切换 · 需授权」
 *   （服务端按本轮席位授权），由模型在需要执行团队任务时按需切换。
 * - 左栏「成员」条目 = 成员维度的私聊入口；群聊「成员切换条」只是**视角过滤**，
 *   不改变成员归属——同一成员可同时出现在多个群聊（如周野在 3 个群里）。
 * - 群聊头部保留人数与成员切换，是为了在解耦后仍能「在群里看某个人说了什么」；
 *   私聊头部只展示该成员信息，避免和群聊语义混淆。
 * - 未读红点点击即清除（模拟已读），置顶仅群聊置顶（对应微信置顶会话）。
 *
 * 可交互点：会话切换（群 ↔ 成员）、成员切换条、右栏 Tab、右栏成员卡操作、
 * 左栏搜索/筛选/置顶、新建群聊浮层、快捷指令发送（追加 mock 消息）。
 * 复用 ../_shared 的 AgentAvatar / AgentBadge / ChatBubble / MessageInput /
 * StatusBadge 与 styles token，视觉语言与 group-chat / dm-chat 一致。
 *
 * ⚠️ 铁律：root height:100% + position:relative，浮层一律 absolute，
 * 零 fixed / 100vh / 100vw（md-docs DeviceFrame 内会溢出）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import {
  AgentAvatar,
  AgentBadge,
  ChatBubble,
  MessageInput,
  StatusBadge,
} from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
import {
  type RoleKey,
  type StatusKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

/* ============================================================================
 * 一、mock 数据（成员平台级 · 群聊只是成员集合）
 * ==========================================================================*/

interface MemberTask {
  title: string;
  status: StatusKey;
}

interface Member {
  id: string;
  name: string;
  role: RoleKey;
  /** 在线状态：在线 / 处理中 / 空闲 */
  status: "在线" | "处理中" | "空闲";
  /** 成员当前一句话状态 */
  note: string;
  /** 绑定的执行 Agent（引擎绑定名） */
  agentKey: string;
  model: string;
  worker: string;
  /** 团队（席位）工作目录：团队上下文执行时以此为准 */
  teamDir: string;
  /** 成员私有工作目录：个人工作台，仅本人使用 */
  privateDir: string;
  skills: string[];
  tasks: MemberTask[];
  /** 已加入的群聊名（★ 解耦后一个成员可属于多个群聊） */
  groups: string[];
  /** 左栏会话摘要 */
  last: string;
  time: string;
  unread: number;
  /** ★ 全局会话（成员维度，跨群唯一）：一个成员只有 1 个 session，所有群聊共享同一份上下文 */
  session: {
    /** 会话 ID（示意，正式实现由后端生成） */
    id: string;
    /** 上下文占用百分比 0-100（用于进度条） */
    percent: number;
    /** 上下文规模展示值 */
    tokens: string;
    /** 最近活跃群聊：只读信息，不代表「私聊锚定哪个群」 */
    lastActive: string;
    /** 待处理消息条数（信息展示，不做排队/拦截） */
    pending?: number;
  };
  /** 该成员当前正在哪个「其他群」处理消息（群聊态忙碌信息条用；无 = 空闲） */
  busyIn?: string;
  /**
   * 成员**专属**通知渠道（只读展示）：渠道归属唯一（团队或成员二选一），
   * 这里只列出已归属该成员的渠道；团队渠道仍可用，但不在此列。
   */
  notify: string[];
  /* 私聊会话 mock 内容 */
  dmIntro: string;
  dmThinking: string;
  dmReply: string;
  dmTool: { name: string; input: string; output: string };
}

const MEMBERS: Member[] = [
  {
    id: "m-lin",
    name: "林知远",
    role: "product",
    status: "在线",
    note: "整理通知中心验收清单",
    agentKey: "vteam-product",
    model: "claude-sonnet-4.5",
    worker: "worker-mac-01",
    teamDir: "/data/vteam-worker/notify-center",
    privateDir: "~/work/linzhiyuan",
    skills: ["需求拆解", "竞品分析", "验收标准"],
    tasks: [
      { title: "通知中心需求清单 v1.2", status: "已完成" },
      { title: "增长实验埋点方案", status: "进行中" },
    ],
    groups: ["通知中心迭代", "增长实验 · 埋点"],
    last: "验收清单已按 FR 对齐，补了免打扰边界条件",
    time: "10:05",
    unread: 2,
    session: { id: "mem-sess-7f3a", percent: 42, tokens: "18.6k tokens", lastActive: "通知中心迭代", pending: 0 },
    notify: [],
    dmIntro:
      "「通知中心迭代」的验收清单已按 FR-01~FR-16 对齐，刚补了免打扰时段的边界条件，麻烦你过一眼。",
    dmThinking: "核对验收项与需求清单的映射关系，确认 3 条 P0 都有明确判定口径，再输出结论…",
    dmReply: "核对完了：3 条 P0 验收口径无歧义，清单 v1.2 已更新到产出物；剩余 P2 我下午补。",
    dmTool: {
      name: "读取产出物",
      input: "产出物/通知中心需求清单 v1.2",
      output: "命中 3 条 P0 验收项，与 FR 一一对应",
    },
  },
  {
    id: "m-chen",
    name: "陈默",
    role: "architect",
    status: "在线",
    note: "评审存储方案",
    agentKey: "vteam-architect",
    model: "deepseek-v3.2",
    worker: "worker-mac-02",
    teamDir: "/data/vteam-worker/arch",
    privateDir: "~/work/chenmo",
    skills: ["架构评审", "存储方案", "接口设计"],
    tasks: [{ title: "免打扰时段存储方案 §3.2", status: "已完成" }],
    groups: ["通知中心迭代", "客户端重构二期"],
    last: "存储方案复用现有配置表，无需新表",
    time: "昨天",
    unread: 0,
    session: { id: "mem-sess-91c4", percent: 63, tokens: "27.4k tokens", lastActive: "客户端重构二期", pending: 2 },
    busyIn: "客户端重构二期",
    notify: ["Webhook-告警"],
    dmIntro:
      "免打扰时段的存储我看了，复用现有 user_config.preferences（JSONB）即可，不需要新表，也不会和用户配置冲突。",
    dmThinking: "检查 user_config 现有字段与迁移脚本，确认新增 JSON 字段是否影响历史数据读取…",
    dmReply: "确认无影响：字段可选、读取侧有默认值兜底。方案已补进《设计文档》§3.2。",
    dmTool: {
      name: "查询代码",
      input: "arch/user-config.ts · user_config.preferences",
      output: "命中 1 处定义，历史迁移脚本兼容可选字段",
    },
  },
  {
    id: "m-zhou",
    name: "周野",
    role: "developer",
    status: "处理中",
    note: "开发未读角标（跨 3 个群聊共享上下文）",
    agentKey: "vteam-developer",
    model: "claude-sonnet-4.5",
    worker: "worker-mac-03",
    teamDir: "/data/vteam-worker/vteam-web",
    privateDir: "~/work/zhouye",
    skills: ["React", "增量渲染", "单元测试"],
    tasks: [
      { title: "未读角标渲染", status: "进行中" },
      { title: "分组折叠组件", status: "待验收" },
      { title: "埋点 SDK 接入", status: "进行中" },
    ],
    groups: ["通知中心迭代", "增长实验 · 埋点", "客户端重构二期"],
    last: "未读角标渲染已修复，等待回归",
    time: "10:18",
    unread: 0,
    session: { id: "mem-sess-4b82", percent: 55, tokens: "24.1k tokens", lastActive: "通知中心迭代", pending: 1 },
    busyIn: "增长实验 · 埋点",
    notify: [],
    dmIntro:
      "未读角标的渲染问题修好了（角标改为按全局会话计算，不再依赖 Team 成员表）。3 个群聊共享同一份上下文，角标会同步。",
    dmThinking: "回溯角标计算链路：全局会话 → 未读计数 → 渲染层，确认成员跨群共享同一会话后角标如何同步…",
    dmReply: "已改成按全局会话计算：跨群共享同一份上下文，角标在多个群聊同步更新，可以进入回归。",
    dmTool: {
      name: "执行测试",
      input: "pnpm vitest run unread-badge",
      output: "12 passed · 3 个群聊场景全部通过",
    },
  },
  {
    id: "m-su",
    name: "苏打",
    role: "tester",
    status: "空闲",
    note: "等待验收用例",
    agentKey: "vteam-tester",
    model: "gpt-5.2",
    worker: "worker-win-01",
    teamDir: "/data/vteam-worker/qa",
    privateDir: "~/work/suda",
    skills: ["回归测试", "用例设计", "性能压测"],
    tasks: [
      { title: "通知中心 P0 回归", status: "进行中" },
      { title: "自测验收清单 v1.0", status: "已完成" },
    ],
    groups: ["通知中心迭代"],
    last: "P0 用例 3 条通过，2 条待修复后复测",
    time: "昨天",
    unread: 4,
    session: { id: "mem-sess-c05d", percent: 18, tokens: "7.9k tokens", lastActive: "通知中心迭代", pending: 0 },
    notify: [],
    dmIntro:
      "P0 回归跑完了：3 条通过，2 条失败（都是未读角标计数），失败用例已挂到产出物，等修复后复测。",
    dmThinking: "汇总回归结果并按失败原因归类，区分「实现问题」与「用例口径问题」…",
    dmReply: "归类完成：2 条失败均为实现问题（已 @周野），用例口径无异议，复测用同一份脚本。",
    dmTool: {
      name: "执行测试",
      input: "pytest regression/test_notification_center.py -m p0",
      output: "3 passed, 2 failed · 失败原因：unread count mismatch",
    },
  },
];

const MEMBER_MAP: Record<string, Member> = Object.fromEntries(MEMBERS.map((m) => [m.id, m]));

/** 群聊：成员集合 + 与任务/产出物的关联（群聊不再「拥有」成员，只引用） */
interface Team {
  id: string;
  name: string;
  short: string;
  /** 群头像渐变（与 roles 色系同族） */
  from: string;
  to: string;
  members: string[];
  pinned: boolean;
  last: string;
  time: string;
  unread: number;
  task: { title: string; status: StatusKey; updatedAt: string; owner: string };
  artifacts: { name: string; detail: string }[];
}

const TEAMS: Team[] = [
  {
    id: "t-notify",
    name: "通知中心迭代",
    short: "通",
    from: "#3B82F6",
    to: "#8B5CF6",
    members: ["m-lin", "m-chen", "m-zhou", "m-su"],
    pinned: true,
    last: "苏打：P0 未读角标用例 2 条失败，已定位",
    time: "10:24",
    unread: 3,
    task: { title: "通知中心迭代", status: "进行中", updatedAt: "10:24", owner: "林知远" },
    artifacts: [
      { name: "通知中心需求清单", detail: "v1.2 · 林知远" },
      { name: "设计文档", detail: "v0.9 · 陈默" },
      { name: "回归测试报告", detail: "P0 · 苏打" },
    ],
  },
  {
    id: "t-growth",
    name: "增长实验 · 埋点",
    short: "增",
    from: "#10B981",
    to: "#0EA5E9",
    members: ["m-lin", "m-zhou"],
    pinned: false,
    last: "周野：埋点 SDK 已接入，等待灰度数据",
    time: "昨天",
    unread: 0,
    task: { title: "增长实验埋点", status: "待验收", updatedAt: "昨天", owner: "林知远" },
    artifacts: [{ name: "埋点方案", detail: "v0.4 · 林知远" }],
  },
  {
    id: "t-refactor",
    name: "客户端重构二期",
    short: "客",
    from: "#F59E0B",
    to: "#EF4444",
    members: ["m-chen", "m-zhou"],
    pinned: false,
    last: "陈默：模块拆分方案 v0.3 已上传",
    time: "周二",
    unread: 12,
    task: { title: "客户端重构二期", status: "进行中", updatedAt: "周二", owner: "陈默" },
    artifacts: [{ name: "模块拆分方案", detail: "v0.3 · 陈默" }],
  },
];

const TEAM_MAP: Record<string, Team> = Object.fromEntries(TEAMS.map((t) => [t.id, t]));

/* ----------------------------- 消息模型 ----------------------------- */

/** 文本沿用 ChatBubble；thinking / tool 为本页局部渲染（对齐 group-chat 的过程消息形态） */
type Msg =
  | {
      kind: "text";
      type: "user" | "agent" | "system";
      text: string;
      authorId?: string;
      time?: string;
    }
  | { kind: "thinking"; authorId: string; text: string; time?: string; done?: boolean }
  | { kind: "tool"; authorId: string; name: string; input: string; output: string; status: "running" | "success"; time?: string };

/** 群聊消息流：成员之间的 @ 协作（作者用 authorId 关联成员，便于「成员切换」过滤） */
const GROUP_MESSAGES: Msg[] = [
  { kind: "text", type: "system", text: "林知远 发起了群聊「通知中心迭代」", time: "09:40" },
  {
    kind: "text",
    type: "user",
    text: "@林知远 本周要排期了，麻烦把「通知中心」的需求优先级梳理一份清单挂到产出物 🙏",
    time: "09:58",
  },
  {
    kind: "text",
    type: "agent",
    authorId: "m-lin",
    text: "收到，已梳理核心 3 条：① 未读角标 P0 ② 分组折叠 P1 ③ 免打扰时段 P2。清单已更新至《通知中心需求清单》v1.1。",
    time: "10:02",
  },
  {
    kind: "text",
    type: "agent",
    authorId: "m-zhou",
    text: "@林知远 ①③ 可以并行开工。不过免打扰时段的配置存储方案需要 @陈默 确认，避免和现有用户配置冲突。",
    time: "10:05",
  },
  {
    kind: "thinking",
    authorId: "m-chen",
    text: "免打扰时段复用现有用户配置表，新增一个 JSON 字段即可，无需新表；先确认迁移脚本对历史数据的影响…",
    time: "10:07",
    done: true,
  },
  {
    kind: "tool",
    authorId: "m-chen",
    name: "查询代码",
    input: "arch/user-config.ts · preferences",
    output: "命中 1 处定义，历史数据兼容可选字段",
    status: "success",
    time: "10:08",
  },
  {
    kind: "text",
    type: "agent",
    authorId: "m-chen",
    text: "确认无冲突：复用现有配置表，新增 JSON 字段即可。方案已补充到《设计文档》§3.2。",
    time: "10:09",
  },
  { kind: "text", type: "system", text: "苏打 加入了群聊", time: "10:16" },
  {
    kind: "text",
    type: "user",
    text: "@all 收到，辛苦 @苏打 今晚先把 P0 未读角标用例跑一轮，明早给我结论。",
    time: "10:18",
  },
  {
    kind: "text",
    type: "agent",
    authorId: "m-su",
    text: "回归清单已挂产出物，P0 共 5 条；我先跑未读角标那 3 条，失败项会附日志。",
    time: "10:20",
  },
  {
    kind: "tool",
    authorId: "m-su",
    name: "执行测试",
    input: "pytest regression/test_notification_center.py -m p0",
    output: "3 passed, 2 failed · unread count mismatch",
    status: "running",
    time: "10:22",
  },
];

/** 私聊消息流：1 对 1，不带 @（成员维度会话，可与其所在群聊无关） */
function dmMessages(m: Member): Msg[] {
  // 注意（v1.3）：来源群 / 上下文分界属于「注入给模型的提示」，不在用户界面展示，
  // 这里只保留用户与 Agent 实际说的内容。
  const g1 = m.groups[0] ?? "通知中心迭代";
  const g2 = m.groups[1] ?? g1;
  return [
    { kind: "text", type: "system", text: `与 ${m.name} 的私聊 · 全局会话（跨 ${m.groups.length} 个群聊共享上下文）`, time: m.time },
    { kind: "text", type: "agent", authorId: m.id, text: m.dmIntro, time: m.time },
    {
      kind: "text",
      type: "user",
      text: "收到，我这边同步一下群里的进度，稍后给你结论。",
      time: "10:06",
    },
    { kind: "thinking", authorId: m.id, text: m.dmThinking, time: "10:07", done: true },
    {
      kind: "tool",
      authorId: m.id,
      name: m.dmTool.name,
      input: m.dmTool.input,
      output: m.dmTool.output,
      status: "success",
      time: "10:08",
    },
    { kind: "text", type: "agent", authorId: m.id, text: m.dmReply, time: "10:09" },
    {
      kind: "text",
      type: "agent",
      authorId: m.id,
      text: `「${g2}」也 @ 我了：那边在确认本周排期与验收口径，我先给结论，细节稍后补。`,
      time: "10:13",
    },
    {
      kind: "text",
      type: "agent",
      authorId: m.id,
      text: `已回复「${g2}」：排期与验收口径沿用「${g1}」的版本，差异点我记在全局会话里。`,
      time: "10:14",
    },
  ];
}

/* ============================================================================
 * 二、布局常量 / scoped 样式
 * ==========================================================================*/

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 左栏会话列表宽（微信式窄列） */
const LEFT_W = 300;
/** 右栏信息宽 */
const RIGHT_W = 288;
/** Dock 收起宽度（对齐 _shared/nav NavDock，内容区 paddingLeft 避让） */
const RAIL_W = 56;

/** 会话筛选 */
type ConvFilter = "all" | "team" | "member";
/** 右栏群聊 Tab */
type RightTab = "task" | "members" | "artifacts";

/** scoped 动画（wc- 前缀防污染其他原型） */
const wcCss = `
@keyframes wc-bounce { 0%,80%,100% { transform: scale(.6); opacity: .45 } 40% { transform: scale(1); opacity: 1 } }
@keyframes wc-pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
@keyframes wc-pop { from { opacity:0; transform: translateY(6px) } to { opacity:1; transform:none } }
`;

/* ============================================================================
 * 三、通用小件
 * ==========================================================================*/

/** 群头像：圆角方块 + 渐变（与成员圆形头像明确区分类型） */
function TeamAvatar({ team, size = 44 }: { team: Team; size?: number }) {
  return (
    <span
      aria-label={`群聊 ${team.name}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: `linear-gradient(135deg, ${team.from}, ${team.to})`,
        color: "#FFFFFF",
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        userSelect: "none",
        ...baseFont,
      }}
    >
      {team.short}
    </span>
  );
}

/** 类型徽章：群 / 成员（颜色区分，解耦后左栏必须是「双类型」列表） */
function KindBadge({ kind }: { kind: "team" | "member" }) {
  const isTeam = kind === "team";
  return (
    <span
      data-testid="conv-kind-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 5px",
        height: 16,
        borderRadius: 4,
        backgroundColor: isTeam ? "#EFF6FF" : "#ECFDF5",
        border: `1px solid ${isTeam ? "#BFDBFE" : "#A7F3D0"}`,
        color: isTeam ? "#2563EB" : "#059669",
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        ...baseFont,
      }}
    >
      {isTeam ? "群" : "成员"}
    </span>
  );
}

/** 未读红点（99+ 截断） */
function UnreadDot({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="conv-unread"
      style={{
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 9,
        backgroundColor: "#EF4444",
        color: "#FFFFFF",
        fontSize: 10,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        flexShrink: 0,
        ...baseFont,
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** 在线状态点 + 文案 */
function OnlineStatus({ m }: { m: Member }) {
  const active = m.status === "处理中";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0 }}>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: m.status === "空闲" ? neutral[400] : roleText[m.role],
          animation: active ? "wc-pulse 1.2s ease-in-out infinite" : undefined,
          flexShrink: 0,
        }}
      />
      <span style={{ whiteSpace: "nowrap" }}>{m.status}</span>
    </span>
  );
}

/** 通用小按钮（次要操作 / 图标按钮） */
function GhostBtn({
  label,
  onClick,
  children,
  testid,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs + 1}px ${space.sm}px`,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
        color: neutral[600],
        fontSize: fontSize.xs,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {children}
    </button>
  );
}

/* ============================================================================
 * 四、左栏：会话列表
 * ==========================================================================*/

/** 会话条目统一结构（群聊 / 成员平铺，仅类型不同） */
interface ConvItem {
  id: string;
  kind: "team" | "member";
  pinned: boolean;
}

/** 左栏排序：置顶在前，其余按 mock 声明顺序（等价于最近活跃时间） */
const CONVS: ConvItem[] = [
  ...TEAMS.map((t) => ({ id: t.id, kind: "team" as const, pinned: t.pinned })),
  ...MEMBERS.map((m) => ({ id: m.id, kind: "member" as const, pinned: false })),
].sort((a, b) => Number(b.pinned) - Number(a.pinned));

function ConversationList({
  activeId,
  filter,
  onFilter,
  query,
  onQuery,
  unread,
  onSelect,
  onNewGroup,
}: {
  activeId: string;
  filter: ConvFilter;
  onFilter: (f: ConvFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  /** 当前未读状态（点击会话后清除） */
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  onNewGroup: () => void;
}) {
  const shown = useMemo(
    () =>
      CONVS.filter((c) => {
        if (filter === "team" && c.kind !== "team") return false;
        if (filter === "member" && c.kind !== "member") return false;
        if (!query.trim()) return true;
        const name = c.kind === "team" ? TEAM_MAP[c.id].name : MEMBER_MAP[c.id].name;
        return name.includes(query.trim());
      }),
    [filter, query],
  );

  const pinnedList = shown.filter((c) => c.pinned);
  const normalList = shown.filter((c) => !c.pinned);

  const filters: { key: ConvFilter; label: string; count: number }[] = [
    { key: "all", label: "全部", count: TEAMS.length + MEMBERS.length },
    { key: "team", label: "群聊", count: TEAMS.length },
    { key: "member", label: "成员", count: MEMBERS.length },
  ];

  return (
    <aside
      data-testid="conv-list"
      style={{
        width: LEFT_W,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#FFFFFF",
        borderRight: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 标题 + 新建群聊 */}
      <div style={{ padding: `${space.lg}px ${space.lg}px ${space.md}px`, display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>会话</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
            {TEAMS.length} 个群聊 · {MEMBERS.length} 位成员
          </div>
        </div>
        <button
          type="button"
          data-testid="new-group-btn"
          aria-label="新建群聊"
          title="新建群聊"
          onClick={onNewGroup}
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: neutral[50],
            color: "#2563EB",
            fontSize: fontSize.xl,
            lineHeight: 1,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            ...baseFont,
          }}
        >
          +
        </button>
      </div>

      {/* 搜索框 */}
      <div style={{ padding: `0 ${space.lg}px ${space.sm}px` }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            height: 32,
            padding: `0 ${space.sm + 2}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[100],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.md, lineHeight: 1 }}>
            ⌕
          </span>
          <input
            data-testid="conv-search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索群聊 / 成员"
            aria-label="搜索群聊或成员"
            style={{
              flex: 1,
              minWidth: 0,
              height: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              color: neutral[700],
              fontSize: fontSize.sm,
              ...baseFont,
            }}
          />
        </div>
      </div>

      {/* 分类筛选 */}
      <div style={{ display: "flex", gap: space.xs, padding: `0 ${space.lg}px ${space.sm}px` }}>
        {filters.map((f) => {
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              data-testid="conv-filter"
              data-active={on ? "true" : "false"}
              onClick={() => onFilter(f.key)}
              style={{
                flex: 1,
                padding: `${space.xs}px 0`,
                borderRadius: radius.sm,
                border: "none",
                backgroundColor: on ? "#EFF6FF" : "transparent",
                color: on ? "#2563EB" : neutral[500],
                fontSize: fontSize.xs,
                fontWeight: on ? 600 : 500,
                cursor: "pointer",
                ...baseFont,
              }}
            >
              {f.label}
              <span style={{ color: on ? "#60A5FA" : neutral[400], marginLeft: 2 }}>{f.count}</span>
            </button>
          );
        })}
      </div>

      {/* 会话条目（滚动区） */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: space.md }}>
        {pinnedList.length > 0 && <GroupLabel text="置顶" />}
        {pinnedList.map((c) => (
          <ConvRow key={c.id} conv={c} activeId={activeId} unread={unread} onSelect={onSelect} />
        ))}
        {pinnedList.length > 0 && <GroupLabel text="全部会话" />}
        {normalList.map((c) => (
          <ConvRow key={c.id} conv={c} activeId={activeId} unread={unread} onSelect={onSelect} />
        ))}
        {shown.length === 0 && (
          <div style={{ padding: space.xl, textAlign: "center", color: neutral[400], fontSize: fontSize.sm }}>
            没有匹配的会话
          </div>
        )}
      </div>

      {/* 底部：成员库入口（解耦后成员独立管理） */}
      <div
        style={{
          borderTop: `1px solid ${neutral[100]}`,
          padding: `${space.sm}px ${space.lg}px`,
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          fontSize: fontSize.xs,
          color: neutral[400],
        }}
      >
        <span>成员库</span>
        <span style={{ color: neutral[300] }}>·</span>
        <span>{MEMBERS.length} 位成员，可加入多个群聊</span>
        <span style={{ marginLeft: "auto", color: "#2563EB", cursor: "pointer" }}>管理 ›</span>
      </div>
    </aside>
  );
}

function GroupLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: `${space.sm}px ${space.lg}px ${space.xs}px`,
        fontSize: 10,
        fontWeight: 600,
        color: neutral[400],
        letterSpacing: "0.04em",
      }}
    >
      {text}
    </div>
  );
}

/** 单条会话：群聊 / 成员共用结构，靠类型徽章 + 头像形状区分 */
function ConvRow({
  conv,
  activeId,
  unread,
  onSelect,
}: {
  conv: ConvItem;
  activeId: string;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
}) {
  const isTeam = conv.kind === "team";
  const team = isTeam ? TEAM_MAP[conv.id] : null;
  const member = !isTeam ? MEMBER_MAP[conv.id] : null;
  const active = conv.id === activeId;
  const unreadCount = unread[conv.id] ?? 0;
  const name = team ? team.name : member!.name;
  const last = team ? team.last : member!.last;
  const time = team ? team.time : member!.time;

  return (
    <button
      type="button"
      data-testid="conv-item"
      data-kind={conv.kind}
      data-id={conv.id}
      data-active={active ? "true" : "false"}
      onClick={() => onSelect(conv.id)}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: space.sm + 2,
        padding: `${space.sm + 2}px ${space.lg}px`,
        border: "none",
        backgroundColor: active ? neutral[100] : "transparent",
        cursor: "pointer",
        textAlign: "left",
        borderLeft: `3px solid ${active ? "#2563EB" : "transparent"}`,
        ...baseFont,
      }}
    >
      {team ? (
        <TeamAvatar team={team} size={40} />
      ) : (
        <span style={{ position: "relative", flexShrink: 0 }}>
          <AgentAvatar role={member!.role} size="md" dot={false} initials={member!.name.slice(0, 1)} />
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: 9,
              height: 9,
              borderRadius: "50%",
              backgroundColor: member!.status === "空闲" ? neutral[400] : roleText[member!.role],
              border: "2px solid #FFFFFF",
            }}
          />
        </span>
      )}

      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
          <span
            style={{
              fontSize: fontSize.md,
              fontWeight: active ? 600 : 500,
              color: neutral[800],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          <KindBadge kind={conv.kind} />
          {isTeam && (
            <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0 }}>{team!.members.length} 人</span>
          )}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            fontSize: fontSize.xs,
            color: neutral[400],
            minWidth: 0,
          }}
        >
          {!isTeam ? (
            <>
              <span style={{ color: roleText[member!.role], flexShrink: 0 }}>{roles[member!.role].label}</span>
              <span style={{ color: neutral[300] }}>·</span>
              <OnlineStatus m={member!} />
            </>
          ) : (
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {last}
            </span>
          )}
        </span>
        {!isTeam && (
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {last}
          </span>
        )}
      </span>

      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: space.xs,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 10, color: neutral[400], whiteSpace: "nowrap" }}>{time}</span>
        <UnreadDot count={unreadCount} />
      </span>
    </button>
  );
}

/* ============================================================================
 * 五、中栏：群聊头部 / 成员切换条 / 私聊头部 / 消息流 / 输入区
 * ==========================================================================*/

/** 群聊头部：群名 + 人数 + 操作（群设置 / 搜索） */
function TeamHeader({
  team,
  onAction,
}: {
  team: Team;
  onAction: (text: string) => void;
}) {
  return (
    <header
      data-testid="team-header"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <TeamAvatar team={team} size={38} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {team.name}
          </span>
          <StatusBadge status={team.task.status} />
        </div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
          群聊 · {team.members.length} 个成员 · 仅被 @ 的成员会收到消息
        </div>
      </div>

      {/* 群成员头像堆叠 */}
      <div aria-label="群成员" style={{ display: "flex", alignItems: "center" }}>
        {team.members.map((id, i) => {
          const m = MEMBER_MAP[id];
          return (
            <span key={id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <AgentAvatar
                role={m.role}
                size="sm"
                initials={m.name.slice(0, 1)}
                style={{ border: "2px solid #FFFFFF" }}
              />
            </span>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
        <GhostBtn label="搜索群内消息" onClick={() => onAction("群内搜索：模拟入口，正式版支持消息/文件检索")}>
          ⌕ 搜索
        </GhostBtn>
        <GhostBtn label="群设置" onClick={() => onAction("群设置：可在此增删成员、修改群名（成员来自成员库）")}>
          ⚙ 群设置
        </GhostBtn>
      </div>
    </header>
  );
}

/** 私聊头部：只展示当前成员信息（无成员切换条）+ 一行只读的「全局会话」信息（新版设计 §3.5） */
function DmHeader({
  member,
  session,
  onAction,
}: {
  member: Member;
  /** 全局会话（成员唯一，跨群共享；「最近活跃群」只读、不可切换） */
  session: Member["session"];
  onAction: (text: string) => void;
}) {
  return (
    <header
      data-testid="dm-header"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.md}px ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <AgentAvatar role={member.role} size="lg" initials={member.name.slice(0, 1)} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {member.name}
          </span>
          <AgentBadge role={member.role} />
          <OnlineStatus m={member} />
        </div>

        {/* 全局会话信息（只读）：全局唯一 session，跨群共享上下文；「最近活跃群」不可切换 */}
        <div
          data-testid="dm-global-session"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            marginTop: 3,
            minWidth: 0,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.5,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "0 5px",
              height: 16,
              borderRadius: 4,
              backgroundColor: "#EFF6FF",
              border: "1px solid #BFDBFE",
              color: "#2563EB",
              fontSize: 9,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <span aria-hidden>◉</span>全局会话
          </span>
          <span style={{ color: neutral[300], flexShrink: 0 }}>·</span>
          <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>跨 {member.groups.length} 个群聊共享上下文</span>
          <span style={{ color: neutral[300], flexShrink: 0 }}>·</span>
          <span
            title={`最近活跃群：${session.lastActive}（只读，全局会话不支持按群切换上下文）`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            最近活跃：{session.lastActive}
            <span
              aria-label="只读"
              style={{
                padding: "0 4px",
                height: 14,
                display: "inline-flex",
                alignItems: "center",
                borderRadius: 3,
                backgroundColor: neutral[100],
                border: `1px solid ${neutral[200]}`,
                color: neutral[400],
                fontSize: 9,
                flexShrink: 0,
              }}
            >
              只读
            </span>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
        <GhostBtn label="查看全局会话流" onClick={() => onAction(`查看 ${member.name} 的全局会话流：跨群共享的完整上下文（示意）`)}>
          ◷ 会话流
        </GhostBtn>
        <GhostBtn label="发起任务" onClick={() => onAction("发起任务：以该成员为主 Agent 新建任务（示意）")}>
          ＋ 发任务
        </GhostBtn>
      </div>
    </header>
  );
}

/** 成员切换条：群聊态专用 ——「全部」+ 各成员，点击切换正在看谁（视角过滤） */
function MemberSwitchBar({
  team,
  focusId,
  onFocus,
}: {
  team: Team;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const allOn = focusId === null;
  return (
    <div
      data-testid="member-switch-bar"
      style={{
        flexShrink: 0,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        padding: `${space.sm}px ${space.xl}px ${space.xs}px`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginBottom: space.xs, minWidth: 0 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: neutral[400],
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          成员切换
        </span>
        <span
          style={{
            fontSize: 10,
            color: neutral[300],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          点击头像切换「正在看谁」，仅过滤消息视角，不改变成员归属
        </span>
        <span
          title="橙标 = 该成员正在其他群处理消息；消息照常送达，不排队、不拦截（全局会话跨群共享）"
          style={{ fontSize: 10, color: "#B45309", marginLeft: "auto", whiteSpace: "nowrap", flexShrink: 0 }}
        >
          <span aria-hidden>●</span> 橙标=忙碌于其他群（照常送达）
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: space.md, overflowX: "auto", paddingBottom: space.xs }}>
        {/* 全部 */}
        <button
          type="button"
          data-testid="member-switch-item"
          data-id="all"
          data-active={allOn ? "true" : "false"}
          onClick={() => onFocus(null)}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
            ...baseFont,
          }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: fontSize.md,
              fontWeight: 600,
              color: allOn ? "#2563EB" : neutral[500],
              backgroundColor: allOn ? "#EFF6FF" : neutral[100],
              border: `2px solid ${allOn ? "#2563EB" : "transparent"}`,
            }}
          >
            全
          </span>
          <span
            style={{
              fontSize: 10,
              color: allOn ? "#2563EB" : neutral[400],
              fontWeight: allOn ? 600 : 500,
              whiteSpace: "nowrap",
            }}
          >
            全部
          </span>
        </button>

        {team.members.map((id) => {
          const m = MEMBER_MAP[id];
          const on = focusId === id;
          const busy = !!m.busyIn;
          return (
            <button
              key={id}
              type="button"
              data-testid="member-switch-item"
              data-id={id}
              data-active={on ? "true" : "false"}
              data-busy={busy ? "true" : "false"}
              onClick={() => onFocus(id)}
              title={
                busy
                  ? `${m.name} 正在「${m.busyIn}」处理消息，消息照常送达，由他自行安排先后`
                  : `查看 ${m.name} 在群里的发言`
              }
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                ...baseFont,
              }}
            >
              <span style={{ position: "relative", display: "inline-flex" }}>
                <span
                  style={{
                    padding: 2,
                    borderRadius: "50%",
                    border: `2px solid ${on ? roleText[m.role] : busy ? "#F59E0B" : "transparent"}`,
                    backgroundColor: on ? roles[m.role].bg : busy ? "#FFFBEB" : "transparent",
                    display: "inline-flex",
                  }}
                >
                  <AgentAvatar
                    role={m.role}
                    size="sm"
                    initials={m.name.slice(0, 1)}
                    dot={false}
                    style={{ width: 30, height: 30, fontSize: 11 }}
                  />
                </span>
                {busy && (
                  <span
                    data-testid="switch-busy-dot"
                    aria-hidden
                    style={{
                      position: "absolute",
                      right: -1,
                      top: -1,
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: "#F59E0B",
                      border: "2px solid #FFFFFF",
                      animation: "wc-pulse 1.4s ease-in-out infinite",
                    }}
                  />
                )}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: busy ? "#B45309" : on ? roleText[m.role] : neutral[400],
                  fontWeight: on || busy ? 600 : 500,
                  whiteSpace: "nowrap",
                  maxWidth: 48,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {m.name}
              </span>
              {busy && (
                <span style={{ fontSize: 9, color: "#B45309", lineHeight: 1, whiteSpace: "nowrap" }}>
                  其他群
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- 过程消息局部渲染 ----------------------------- */

/** 三连点动画 */
function LoadingDots({ color = neutral[400] }: { color?: string }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", gap: 3, lineHeight: 0 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            backgroundColor: color,
            animation: "wc-bounce 1.1s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}

/** 思考中（可折叠）：对应 opencode ReasoningPart */
function MsgThinking({
  author,
  role,
  text,
  time,
  done,
}: {
  author: string;
  role: RoleKey;
  text: string;
  time?: string;
  done?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="msg-thinking"
      style={{ display: "flex", alignItems: "flex-start", gap: space.sm, maxWidth: "78%" }}
    >
      <AgentAvatar role={role} size="sm" dot={false} initials={author.slice(0, 1)} style={{ marginTop: 2 }} />
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          cursor: "pointer",
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>💭</span>
          <span style={{ fontSize: fontSize.sm, color: neutral[500], fontWeight: 500, fontStyle: "italic" }}>
            {author} · 已思考
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto", whiteSpace: "nowrap" }}>
            {open ? "▾ 收起" : "展开 ▸"}
          </span>
          {time && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{time}</span>}
        </div>
        {open && (
          <div
            style={{
              marginTop: space.xs,
              fontSize: fontSize.md,
              color: neutral[600],
              fontStyle: "italic",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {text}
          </div>
        )}
      </button>
      {done === false && <LoadingDots />}
    </div>
  );
}

/** 工具调用卡片：状态 运行中（spinner）/ 成功（✓） */
function MsgTool({
  author,
  role,
  name,
  input,
  output,
  status,
  time,
}: {
  author: string;
  role: RoleKey;
  name: string;
  input: string;
  output: string;
  status: "running" | "success";
  time?: string;
}) {
  const running = status === "running";
  return (
    <div
      data-testid="msg-tool"
      data-status={status}
      style={{ display: "flex", alignItems: "flex-start", gap: space.sm, maxWidth: "78%" }}
    >
      <AgentAvatar role={role} size="sm" dot={false} initials={author.slice(0, 1)} style={{ marginTop: 2 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>⚙</span>
          <span style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 600 }}>{name}</span>
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: "1px 6px",
              borderRadius: radius.pill,
              backgroundColor: running ? "#FFFBEB" : "#ECFDF5",
              border: `1px solid ${running ? "#FDE68A" : "#A7F3D0"}`,
              color: running ? "#D97706" : "#059669",
              fontSize: fontSize.xs,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {running ? <LoadingDots color="#D97706" /> : <span aria-hidden>✓</span>}
            {running ? "运行中" : "成功"}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            marginTop: space.sm,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: "flex", gap: space.sm }}>
            <span style={{ color: neutral[400], flexShrink: 0 }}>输入</span>
            <span style={{ fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{input}</span>
          </div>
          <div style={{ display: "flex", gap: space.sm }}>
            <span style={{ color: neutral[400], flexShrink: 0 }}>输出</span>
            <span style={{ color: neutral[600], wordBreak: "break-word" }}>{output}</span>
          </div>
        </div>
        <div style={{ marginTop: space.sm, fontSize: fontSize.xs, color: neutral[400] }}>
          {author}
          {time ? ` · ${time}` : ""}
        </div>
      </div>
    </div>
  );
}

/** 消息流：群聊 / 私聊共用（成员切换时按作者过滤） */
function MessageList({
  msgs,
  focusName,
  onClearFocus,
}: {
  msgs: Msg[];
  focusName?: string;
  onClearFocus?: () => void;
}) {
  // 聊天默认停在最新消息：会话 / 视角 / 消息数变化时滚到底部（避免截图与首屏露出半截气泡）
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, focusName]);

  return (
    // 外层纵向容器：把「视角过滤条」固定在滚动区之上，避免滚到底部后提示被滚走
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
      {focusName && (
        <div
          data-testid="focus-strip"
          style={{
            flexShrink: 0,
            display: "flex",
            justifyContent: "center",
            padding: `${space.xs}px ${space.xl}px 0`,
            backgroundColor: neutral[50],
          }}
        >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.xs}px ${space.md}px`,
            borderRadius: radius.pill,
            backgroundColor: "#EFF6FF",
            border: "1px solid #BFDBFE",
            color: "#2563EB",
            fontSize: fontSize.xs,
            fontWeight: 500,
          }}
        >
          仅看 {focusName} 的发言
          <button
            type="button"
            onClick={onClearFocus}
            style={{
              border: "none",
              background: "transparent",
              color: "#2563EB",
              fontSize: fontSize.xs,
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
              ...baseFont,
            }}
          >
            清除
          </button>
        </div>
        </div>
      )}

      <div
        ref={listRef}
        data-testid="chat-message-list"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${space.lg}px ${space.xl}px`,
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          backgroundColor: neutral[50],
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md, flexShrink: 0 }}>
          <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 会话</span>
          <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        </div>

        {msgs.map((msg, i) => {
        if (msg.kind === "thinking") {
          const m = MEMBER_MAP[msg.authorId];
          return (
            <MsgThinking key={i} author={m.name} role={m.role} text={msg.text} time={msg.time} done={msg.done} />
          );
        }
        if (msg.kind === "tool") {
          const m = MEMBER_MAP[msg.authorId];
          return (
            <MsgTool
              key={i}
              author={m.name}
              role={m.role}
              name={msg.name}
              input={msg.input}
              output={msg.output}
              status={msg.status}
              time={msg.time}
            />
          );
        }
          const author = msg.authorId ? MEMBER_MAP[msg.authorId] : null;
          // v1.3：不展示任何自动注入的提示（来源群/上下文分界等），只呈现用户与 Agent 的实际内容
          return (
            <ChatBubble
              key={i}
              text={msg.text}
              type={msg.type}
              author={author?.name}
              role={author?.role}
              time={msg.time}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 底部输入区：复用 MessageInput + 快捷指令（点击追加一条 mock 消息，体现可交互） */
function Composer({
  mentionable,
  placeholder,
  quick,
  onQuick,
  hint,
}: {
  mentionable: RoleKey[];
  placeholder: string;
  quick: { label: string; text: string }[];
  onQuick: (text: string) => void;
  hint: string;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        backgroundColor: "#FFFFFF",
        borderTop: `1px solid ${neutral[200]}`,
        paddingTop: space.xs,
        ...baseFont,
      }}
    >
      {/* 快捷指令行（原型交互：点击即发送） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.xs, padding: `0 ${space.lg}px` }}>
        <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0 }}>快捷：</span>
        <div style={{ display: "flex", gap: space.xs, overflowX: "auto", flex: 1, minWidth: 0 }}>
          {quick.map((q) => (
            <button
              key={q.label}
              type="button"
              data-testid="quick-send"
              onClick={() => onQuick(q.text)}
              style={{
                padding: `1px ${space.sm}px`,
                borderRadius: radius.pill,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: neutral[50],
                color: neutral[600],
                fontSize: 10,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                ...baseFont,
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: neutral[300], whiteSpace: "nowrap", flexShrink: 0 }}>{hint}</span>
      </div>
      <MessageInput
        mentionable={mentionable}
        placeholder={placeholder}
        style={{ border: "none", borderRadius: 0, boxShadow: "none" }}
      />
    </div>
  );
}

/* ============================================================================
 * 六、右栏：群聊 Tab（任务 / 成员 / 产出）与私聊成员信息卡
 * ==========================================================================*/

function RightTabBar({ tab, onTab }: { tab: RightTab; onTab: (t: RightTab) => void }) {
  const tabs: { key: RightTab; label: string }[] = [
    { key: "task", label: "任务" },
    { key: "members", label: "成员" },
    { key: "artifacts", label: "产出" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: space.xs,
        padding: space.sm,
        borderBottom: `1px solid ${neutral[200]}`,
        flexShrink: 0,
        ...baseFont,
      }}
    >
      {tabs.map((t) => {
        const on = t.key === tab;
        return (
          <button
            key={t.key}
            type="button"
            data-testid="right-tab"
            data-active={on ? "true" : "false"}
            onClick={() => onTab(t.key)}
            style={{
              flex: 1,
              padding: `${space.xs + 1}px 0`,
              borderRadius: radius.sm,
              border: "none",
              backgroundColor: on ? neutral[100] : "transparent",
              color: on ? neutral[800] : neutral[500],
              fontSize: fontSize.sm,
              fontWeight: on ? 600 : 500,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** 键值行（信息卡用） */
function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: space.sm, fontSize: fontSize.xs, lineHeight: 1.6 }}>
      <span style={{ color: neutral[400], width: 58, flexShrink: 0 }}>{label}</span>
      <span style={{ color: neutral[700], flex: 1, minWidth: 0, wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

/** 右栏 · 群聊态：任务 / 成员 / 产出 三 Tab */
function TeamRightPanel({
  team,
  tab,
  onTab,
  onOpenDm,
  onAction,
}: {
  team: Team;
  tab: RightTab;
  onTab: (t: RightTab) => void;
  onOpenDm: (id: string) => void;
  onAction: (text: string) => void;
}) {
  return (
    <aside
      data-testid="right-panel"
      data-mode="team"
      style={{
        width: RIGHT_W,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#FFFFFF",
        borderLeft: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <RightTabBar tab={tab} onTab={onTab} />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.lg }}>
        {tab === "task" && (
          <>
            <div>
              <div style={{ fontSize: 10, color: neutral[400], marginBottom: space.xs }}>关联任务</div>
              <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
                {team.task.title}
              </div>
              <div style={{ marginTop: space.sm, display: "flex", alignItems: "center", gap: space.sm }}>
                <StatusBadge status={team.task.status} />
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>更新于 {team.task.updatedAt}</span>
              </div>
              <div style={{ marginTop: space.md, fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6 }}>
                群聊只持有任务引用；成员从成员库加入，可同时服务多个群聊与任务。
              </div>
            </div>

            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
                参与成员 · {team.members.length}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                {team.members.map((id) => {
                  const m = MEMBER_MAP[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      data-testid="right-member-row"
                      onClick={() => onOpenDm(id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: space.sm,
                        padding: `${space.xs + 1}px ${space.sm}px`,
                        borderRadius: radius.md,
                        border: `1px solid ${neutral[200]}`,
                        backgroundColor: neutral[50],
                        cursor: "pointer",
                        textAlign: "left",
                        ...baseFont,
                      }}
                    >
                      <AgentAvatar role={m.role} size="sm" initials={m.name.slice(0, 1)} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[800], fontWeight: 500 }}>
                          {m.name}
                        </span>
                        <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>
                          {roles[m.role].label} ·{" "}
                          <span title={m.busyIn ? `正在「${m.busyIn}」处理消息，消息照常送达` : undefined}>
                            {m.busyIn ? "其他群处理中" : m.status}
                          </span>
                        </span>
                      </span>
                      <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.md }}>
                        ›
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: "auto" }}>
              <div
                style={{
                  padding: space.md,
                  borderRadius: radius.lg,
                  backgroundColor: neutral[50],
                  border: `1px dashed ${neutral[300]}`,
                }}
              >
                <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.xs }}>
                  查看 Agent 会话
                </div>
                <div style={{ fontSize: 10, color: neutral[500], lineHeight: 1.6, marginBottom: space.sm }}>
                  Agent 内部推理过程不广播到群聊，仅最终回复展示。
                </div>
                <button
                  type="button"
                  onClick={() => onAction("查看 Agent 会话：打开该成员处理过程面板（示意）")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.xs + 1}px ${space.md}px`,
                    borderRadius: radius.pill,
                    border: "none",
                    backgroundColor: "#2563EB",
                    color: "#FFFFFF",
                    fontSize: fontSize.xs,
                    fontWeight: 500,
                    cursor: "pointer",
                    ...baseFont,
                  }}
                >
                  打开会话面板 →
                </button>
              </div>
            </div>
          </>
        )}

        {tab === "members" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
                群成员 · {team.members.length}
              </span>
              <span style={{ fontSize: 10, color: neutral[400] }}>来自成员库，点击进入私聊</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              {team.members.map((id) => {
                const m = MEMBER_MAP[id];
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid="right-member-item"
                    onClick={() => onOpenDm(id)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: space.sm,
                      padding: space.sm,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "#FFFFFF",
                      cursor: "pointer",
                      textAlign: "left",
                      ...baseFont,
                    }}
                  >
                    <AgentAvatar role={m.role} size="sm" initials={m.name.slice(0, 1)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                        <span style={{ fontSize: fontSize.sm, color: neutral[800], fontWeight: 600 }}>{m.name}</span>
                        <span style={{ fontSize: 10, color: neutral[400] }}>{roles[m.role].label}</span>
                      </span>
                      <span style={{ display: "block", fontSize: 10, color: neutral[400], marginTop: 2 }}>
                        {m.agentKey} · 加入 {m.groups.length} 个群聊
                        {m.notify.length > 0 && (
                          <span
                            data-testid="member-notify-badge"
                            title={`成员专属渠道：${m.notify.join("、")}（归属唯一，团队渠道仍可用）`}
                            style={{
                              marginLeft: space.xs,
                              padding: "0 4px",
                              height: 13,
                              display: "inline-flex",
                              alignItems: "center",
                              borderRadius: 3,
                              backgroundColor: "#EFF6FF",
                              border: "1px solid #BFDBFE",
                              color: "#2563EB",
                              fontSize: 9,
                              fontWeight: 600,
                              verticalAlign: 1,
                            }}
                          >
                            渠道 {m.notify.length}
                          </span>
                        )}
                      </span>
                    </span>
                    <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.md, lineHeight: 1 }}>
                      ›
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.7 }}>
              成员是平台级资产：同一成员可出现在多个群聊会话中，此处移除仅代表退出本群。
            </div>
          </>
        )}

        {tab === "artifacts" && (
          <>
            <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
              产出物 · {team.artifacts.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              {team.artifacts.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  data-testid="artifact-link"
                  onClick={() => onAction(`打开产出物《${a.name}》（示意）`)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.sm}px ${space.md}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: neutral[50],
                    cursor: "pointer",
                    textAlign: "left",
                    ...baseFont,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: "#2563EB", flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[800], fontWeight: 500 }}>
                      {a.name}
                    </span>
                    <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>{a.detail}</span>
                  </span>
                  <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.sm }}>
                    ↗
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/** 右栏 · 私聊态：该成员信息卡（解耦后成员才是「一等信息主体」） */
function MemberRightPanel({
  member,
  session,
  onResetSession,
  onAction,
}: {
  member: Member;
  /** 全局会话（成员唯一、跨群共享；重置会清空所有群聊的上下文） */
  session: Member["session"];
  /** 打开「重置全局会话」二次确认弹窗 */
  onResetSession: () => void;
  onAction: (text: string) => void;
}) {
  return (
    <aside
      data-testid="right-panel"
      data-mode="member"
      style={{
        width: RIGHT_W,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#FFFFFF",
        borderLeft: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.md }}>
        {/* 头部 */}
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <AgentAvatar role={member.role} size="lg" initials={member.name.slice(0, 1)} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
              <span style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{member.name}</span>
              <KindBadge kind="member" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: 2 }}>
              <AgentBadge role={member.role} />
              <OnlineStatus m={member} />
            </div>
          </div>
        </div>

        <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.7 }}>
          {member.note} · 已加入 {member.groups.length} 个群聊
        </div>

        {/* 会话（全局唯一：一个成员只有 1 个 session，跨群共享上下文，不按群隔离） */}
        <div data-testid="member-session-card">
          <div style={{ display: "flex", alignItems: "center", gap: space.xs, marginBottom: space.xs }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: neutral[400], letterSpacing: "0.04em" }}>
              会话
            </span>
            <span
              style={{
                padding: "0 4px",
                height: 15,
                display: "inline-flex",
                alignItems: "center",
                borderRadius: 3,
                backgroundColor: "#EFF6FF",
                border: "1px solid #BFDBFE",
                color: "#2563EB",
                fontSize: 9,
                fontWeight: 600,
              }}
            >
              全局唯一
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.xs,
              padding: space.sm,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
            }}
          >
            <InfoRow
              label="会话 ID"
              value={<span style={{ fontFamily: fontFamily.mono, fontSize: 10 }}>{session.id}</span>}
            />
            <InfoRow
              label="状态"
              value={
                <span
                  title="仅信息展示：不做排队/流控，A/B 群随时可 @，消息一律送达"
                  style={{ display: "inline-flex", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs }}>
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: session.percent > 0 ? "#F59E0B" : neutral[300],
                      }}
                    />
                    {session.percent > 0 ? "处理中" : "空闲"}
                  </span>
                  <span style={{ color: neutral[400], fontSize: 9 }}>
                    · 待处理 {session.pending ?? 0} 条（照常送达）
                  </span>
                </span>
              }
            />
            <InfoRow label="上下文" value={`${session.percent}% · ${session.tokens}`} />
            {/* 上下文占用进度条：全局会话跨群累积 */}
            <div
              aria-hidden
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: neutral[200],
                overflow: "hidden",
                margin: "2px 0",
              }}
            >
              <div
                style={{
                  width: `${session.percent}%`,
                  height: "100%",
                  backgroundColor: session.percent > 85 ? "#DC2626" : "#2563EB",
                  transition: "width .2s ease",
                }}
              />
            </div>
            <InfoRow
              label="最近活跃"
              value={
                <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {session.lastActive}
                  </span>
                  <span style={{ color: neutral[400], fontSize: 9, flexShrink: 0 }}>只读</span>
                </span>
              }
            />
            <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.5 }}>
              跨群共享、不按群隔离；重置影响全部群聊。
            </div>
          </div>
        </div>

        {/* 运行参数 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: neutral[400], letterSpacing: "0.04em" }}>运行配置</div>
          <InfoRow label="执行 Agent" value={<span style={{ fontFamily: fontFamily.mono }}>{member.agentKey}</span>} />
          <InfoRow label="默认模型" value={<span style={{ fontFamily: fontFamily.mono }}>{member.model}</span>} />
          <InfoRow label="Worker" value={<span style={{ fontFamily: fontFamily.mono }}>{member.worker}</span>} />
          {/* 工作目录（v1.3）：私有目录 = 默认 cwd；团队目录 = 可切换 · 需授权 */}
          <div data-testid="workdir-block" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
              <span style={{ color: neutral[400], width: 52, flexShrink: 0, fontSize: fontSize.xs }}>私有目录</span>
              <span
                data-testid="dir-badge-default"
                style={{
                  padding: "0 4px",
                  height: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 3,
                  backgroundColor: "#ECFDF5",
                  border: "1px solid #A7F3D0",
                  color: "#059669",
                  fontSize: 9,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                默认 cwd
              </span>
            </div>
            <div
              style={{
                fontFamily: fontFamily.mono,
                fontSize: 10,
                color: neutral[700],
                paddingLeft: 60,
                wordBreak: "break-all",
              }}
            >
              {member.privateDir}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: 2 }}>
              <span style={{ color: neutral[400], width: 52, flexShrink: 0, fontSize: fontSize.xs }}>团队目录</span>
              <span
                data-testid="dir-badge-switch"
                title="团队目录不是默认目录：模型按需切换，服务端按本轮席位授权"
                style={{
                  padding: "0 4px",
                  height: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 3,
                  backgroundColor: "#FFFBEB",
                  border: "1px solid #FDE68A",
                  color: "#B45309",
                  fontSize: 9,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                可切换 · 需授权
              </span>
            </div>
            <div
              style={{
                fontFamily: fontFamily.mono,
                fontSize: 10,
                color: neutral[700],
                paddingLeft: 60,
                wordBreak: "break-all",
              }}
            >
              {member.teamDir}
            </div>
            <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.5 }}>
              默认在私有目录执行；模型可按需切换到团队目录（服务端按本轮席位授权）。
            </div>
          </div>
        </div>

        {/* 成员专属渠道（归属唯一，只读；管理入口在成员库） */}
        <button
          type="button"
          data-testid="member-notify-row"
          onClick={() =>
            onAction(
              `成员专属渠道在成员库（member-manage）中管理：该成员当前独占 ${member.notify.length} 个渠道；渠道归属唯一（团队或成员二选一），团队渠道仍可用`,
            )
          }
          title={`成员专属渠道：${member.notify.length > 0 ? member.notify.join("、") : "无（团队渠道仍可用）"}（点击去成员库管理）`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.xs + 1}px ${space.sm}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            cursor: "pointer",
            textAlign: "left",
            ...baseFont,
          }}
        >
          <span aria-hidden style={{ color: "#2563EB", fontSize: fontSize.md, lineHeight: 1 }}>
            ◔
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>成员专属渠道</span>
            <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[700], marginTop: 1 }}>
              {member.notify.length === 0 ? (
                <span style={{ color: neutral[400] }}>无成员专属渠道（团队渠道仍可用）</span>
              ) : (
                <>
                  已绑定 {member.notify.length} 个 · {member.notify[0]}
                  {member.notify.length > 1 ? ` +${member.notify.length - 1}` : ""}
                </>
              )}
            </span>
          </span>
          <span style={{ fontSize: 9, color: neutral[400], whiteSpace: "nowrap", flexShrink: 0 }}>
            去成员库 ›
          </span>
        </button>

        {/* 技能 */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: neutral[400], letterSpacing: "0.04em", marginBottom: space.xs }}>
            技能
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
            {member.skills.map((s) => (
              <span
                key={s}
                style={{
                  padding: `${space.xs - 1}px ${space.sm}px`,
                  borderRadius: radius.pill,
                  backgroundColor: roles[member.role].bg,
                  border: `1px solid ${roles[member.role].border}`,
                  color: roleText[member.role],
                  fontSize: 10,
                  fontWeight: 500,
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </div>

        {/* 最近任务 */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: neutral[400], letterSpacing: "0.04em", marginBottom: space.xs }}>
            最近任务
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            {member.tasks.map((t) => (
              <div
                key={t.title}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.xs + 1}px ${space.sm}px`,
                  borderRadius: radius.sm,
                  border: `1px solid ${neutral[200]}`,
                  fontSize: fontSize.xs,
                  color: neutral[700],
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </span>
                <StatusBadge status={t.status} style={{ fontSize: 10, padding: "0 5px" }} />
              </div>
            ))}
          </div>
        </div>
        {/* 所在群聊（解耦关键信息） */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: neutral[400], letterSpacing: "0.04em", marginBottom: space.xs }}>
            所在群聊 · {member.groups.length}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            {member.groups.map((g) => (
              <div
                key={g}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.xs,
                  padding: `${space.xs}px ${space.sm}px`,
                  borderRadius: radius.sm,
                  backgroundColor: neutral[50],
                  border: `1px solid ${neutral[200]}`,
                  fontSize: fontSize.xs,
                  color: neutral[600],
                }}
              >
                <span aria-hidden style={{ color: "#2563EB" }}>
                  ▤
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {g}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* 操作区 */}
      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${neutral[200]}`,
          padding: space.md,
          display: "flex",
          flexDirection: "column",
          gap: space.xs,
        }}
      >
        <button
          type="button"
          data-testid="member-action"
          onClick={() => onAction(`向 ${member.name} 发任务：创建任务并指定其为主 Agent（示意）`)}
          style={{
            padding: `${space.sm}px 0`,
            borderRadius: radius.md,
            border: "none",
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: "pointer",
            ...baseFont,
          }}
        >
          发任务
        </button>
        <div style={{ display: "flex", gap: space.xs }}>
          <button
            type="button"
            data-testid="reset-global-session"
            onClick={onResetSession}
            style={{
              flex: 1,
              padding: `${space.xs + 1}px 0`,
              borderRadius: radius.md,
              border: "1px solid #FECACA",
              backgroundColor: "#FEF2F2",
              color: "#B91C1C",
              fontSize: fontSize.xs,
              fontWeight: 500,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            重置全局会话
          </button>
          <button
            type="button"
            data-testid="member-action"
            onClick={() => onAction(`查看 ${member.name} 的全局会话流：跨群共享上下文（示意）`)}
            style={{
              flex: 1,
              padding: `${space.xs + 1}px 0`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.xs,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            查看会话流
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * 群聊态「成员正在其他群忙」信息条（v1.2：**不做排队/流控**）。
 * A/B 群都可随时 @ 成员，消息一律送达、不拦截、不显示位次，由成员自行安排先后；
 * 这里只做信息告知，避免「被拦住」的错觉。
 */
function BusyBanner({ team }: { team: Team }) {
  const busy = team.members.map((id) => MEMBER_MAP[id]).filter((m) => !!m.busyIn);
  if (busy.length === 0) return null;
  const first = busy[0];
  return (
    <div
      data-testid="busy-banner"
      title={busy
        .map((m) => `${m.name} 正在「${m.busyIn}」处理消息，消息照常送达，由他自行安排先后`)
        .join("；")}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.xs + 1}px ${space.xl}px`,
        backgroundColor: "#FFFBEB",
        borderBottom: "1px solid #FDE68A",
        fontSize: fontSize.xs,
        color: "#B45309",
        lineHeight: 1.5,
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1, flexShrink: 0 }}>
        ⏳
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <strong>{first.name}</strong> 正在「{first.busyIn}」处理消息，消息照常送达
      </span>
      <span
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {busy.length > 1 && (
          <span
            data-testid="busy-more"
            style={{
              padding: "0 6px",
              height: 16,
              display: "inline-flex",
              alignItems: "center",
              borderRadius: radius.pill,
              backgroundColor: "#FEF3C7",
              border: "1px solid #FDE68A",
              fontWeight: 600,
              fontSize: 9,
            }}
          >
            {busy.length} 位成员在其他群处理中
          </span>
        )}
        <span style={{ fontSize: 9, color: "#D97706", whiteSpace: "nowrap" }}>不拦截 · 自行安排先后</span>
      </span>
    </div>
  );
}

/** 重置全局会话二次确认：影响该成员在所有群聊的上下文（不可恢复） */
function SessionResetModal({
  member,
  session,
  onCancel,
  onConfirm,
}: {
  member: Member;
  session: Member["session"];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      data-testid="session-reset-overlay"
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 45,
        backgroundColor: "rgba(15,23,42,.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        data-testid="session-reset-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 470,
          maxWidth: "100%",
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.lg,
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          animation: "wc-pop .16s ease-out",
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <AgentAvatar role={member.role} size="md" initials={member.name.slice(0, 1)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              重置「{member.name}」的全局会话
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
              会话 {session.id} · {session.percent}% · {session.tokens}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              cursor: "pointer",
              lineHeight: 1,
              padding: space.xs,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: "#FEF2F2",
            border: "1px solid #FECACA",
            color: "#B91C1C",
            fontSize: fontSize.xs,
            lineHeight: 1.75,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>⚠ 影响该成员在所有群聊的上下文</div>
          该成员在 {member.groups.map((g) => `「${g}」`).join("、")} 中共享同一个全局会话；重置会清空全部
          上下文（当前 {session.tokens}），其他群聊里依赖该上下文的进行中任务会失去上下文，且不可恢复。
        </div>

        <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.7 }}>
          重置后：会话 ID 保持不变，上下文归零，状态变为空闲；私聊与所有群聊同时生效（全局唯一会话）。
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, paddingTop: space.xs }}>
          <button
            type="button"
            data-testid="reset-cancel"
            onClick={onCancel}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="reset-confirm"
            onClick={onConfirm}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              fontSize: fontSize.sm,
              fontWeight: 600,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            确认重置（影响 {member.groups.length} 个群聊）
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * 七、新建群聊浮层（绝对定位，非独立路由；正式流程见 group-create 原型）
 * ==========================================================================*/

function NewGroupPopover({ onClose, onToast }: { onClose: () => void; onToast: (t: string) => void }) {
  return (
    <div
      data-testid="new-group-overlay"
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        backgroundColor: "rgba(15,23,42,.24)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        data-testid="new-group-popover"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "100%",
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.lg,
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          animation: "wc-pop .16s ease-out",
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>新建群聊</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2 }}>
              从成员库选择成员组建群聊，一个成员可加入多个群聊
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              cursor: "pointer",
              lineHeight: 1,
              padding: space.xs,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px dashed ${neutral[300]}`,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.7,
          }}
        >
          完整流程（选成员 → 群设置 → 确认创建）见 <strong style={{ color: neutral[700] }}>group-create 原型</strong>；
          成员可先在 <strong style={{ color: neutral[700] }}>member-manage 原型</strong> 中创建。
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="new-group-confirm"
            onClick={() => {
              onToast("新建群聊：正式版跳转 group-create 流程（本原型为会话页示意）");
              onClose();
            }}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            去建群 →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * 八、主组件
 * ==========================================================================*/

function WechatChat(_: PrototypeRenderProps) {
  // 当前会话：群聊 id 或成员 id（统一 id 空间，靠 kind 判定）
  const [activeId, setActiveId] = useState("t-notify");
  const [filter, setFilter] = useState<ConvFilter>("all");
  const [query, setQuery] = useState("");
  /** 群聊内「正在看谁」：null = 全部 */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tab, setTab] = useState<RightTab>("task");
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [toast, setToast] = useState("");
  /** 点击后清除未读（模拟已读） */
  const [unread, setUnread] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    TEAMS.forEach((t) => (init[t.id] = t.unread));
    MEMBERS.forEach((m) => (init[m.id] = m.unread));
    return init;
  });
  /** 快捷发送追加的 mock 消息（按会话 id 分开存放，仅前端 mock） */
  const [extra, setExtra] = useState<Record<string, Msg[]>>({});
  /** 全局会话被重置后的覆盖值（percent/tokens 归零，会话 ID 不变） */
  const [sessionOverride, setSessionOverride] = useState<Record<string, { percent: number; tokens: string }>>({});
  /** 正在二次确认「重置全局会话」的成员 id（null = 无弹窗） */
  const [sessionResetFor, setSessionResetFor] = useState<string | null>(null);

  const team = TEAM_MAP[activeId] ?? null;
  const member = MEMBER_MAP[activeId] ?? null;
  const isTeam = !!team;

  /** 消息流：群聊按 focusId 过滤；私聊固定单人 */
  const msgs = useMemo<Msg[]>(() => {
    if (member) return [...dmMessages(member), ...(extra[member.id] ?? [])];
    const base = [...GROUP_MESSAGES, ...(extra[activeId] ?? [])];
    if (!focusId) return base;
    return base.filter((m) =>
      m.kind === "text" ? m.type === "user" || m.authorId === focusId : m.authorId === focusId,
    );
  }, [activeId, member, focusId, extra]);

  const selectConv = (id: string) => {
    setActiveId(id);
    setFocusId(null);
    setTab("task");
    setUnread((prev) => ({ ...prev, [id]: 0 }));
  };

  /** 解析成员的全局会话（重置后用覆盖值） */
  const sessionOf = (m: Member): Member["session"] => {
    const o = sessionOverride[m.id];
    return o ? { ...m.session, percent: o.percent, tokens: o.tokens } : m.session;
  };

  const pushToast = (text: string) => setToast(text);

  /**
   * 快捷发送：追加一条 user 消息（纯前端 mock）。
   * v1.2：**取消排队/流控**，发送永远成功；若成员正在其他群忙，只做信息提示
   * （已送达 + 对方处理完当前内容后会查看），不出现位次/拦截感。
   */
  const quickSend = (text: string) => {
    setExtra((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), { kind: "text", type: "user", text, time: "刚刚" }],
    }));
    if (!team) return;
    const busy = team.members.map((id) => MEMBER_MAP[id]).filter((m) => !!m.busyIn);
    if (busy.length === 0) {
      pushToast("已送达：本群消息已发送，成员当前空闲");
      return;
    }
    pushToast(
      `已送达：${busy[0].name} 正在其他群处理，处理完当前内容后会查看（消息不排队、不拦截）`,
    );
  };

  /** 重置全局会话：上下文归零 + 状态空闲，并提示影响的群聊数量 */
  const resetGlobalSession = (m: Member) => {
    setSessionOverride((prev) => ({ ...prev, [m.id]: { percent: 0, tokens: "0 tokens" } }));
    setSessionResetFor(null);
    pushToast(`已重置「${m.name}」的全局会话：上下文已清空，影响其 ${m.groups.length} 个群聊`);
  };

  const quickGroup = [
    { label: "@林知远 排期", text: "@林知远 麻烦把本周排期同步一下，我这边好对齐资源。" },
    { label: "@周野 进度", text: "@周野 未读角标修完后同步一下，我安排回归。" },
    { label: "@all 通知", text: "@all 明早 10:00 站会，同步各自进度与阻塞。" },
  ];
  const quickDm = [
    { label: "同步进度", text: "同步一下当前进度和阻塞点，我这边好安排。" },
    { label: "发任务", text: "把这件事当成一个任务推进，完成后同步结论。" },
    { label: "要产出", text: "结论整理成产出物挂到会话里，方便其他人复用。" },
  ];

  return (
    <div
      data-testid="wechat-chat-root"
      style={{
        height: "100%",
        minHeight: 720,
        position: "relative",
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      <style>{wcCss}</style>

      {/* 顶部：面包屑 + Cmd+K（与 group-chat / dm-chat 同一融合导航语言） */}
      <NavTopBar
        breadcrumb={["Agent 协作平台", "消息中心"]}
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：绝对定位填满顶栏以下，paddingLeft 避让左侧悬浮 Dock */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          paddingLeft: RAIL_W + 24,
          backgroundColor: "#FFFFFF",
        }}
      >
        <ConversationList
          activeId={activeId}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          unread={unread}
          onSelect={selectConv}
          onNewGroup={() => setNewGroupOpen(true)}
        />

        {/* 中栏：消息区（群聊 / 私聊两种形态） */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
          {team ? (
            <>
              <TeamHeader team={team} onAction={pushToast} />
              <MemberSwitchBar team={team} focusId={focusId} onFocus={setFocusId} />
              <BusyBanner team={team} />
              <MessageList
                msgs={msgs}
                focusName={focusId ? MEMBER_MAP[focusId].name : undefined}
                onClearFocus={() => setFocusId(null)}
              />
              <Composer
                mentionable={["product", "architect", "developer", "tester"]}
                placeholder="输入消息，@ 提及群内成员（成员来自成员库）…"
                quick={quickGroup}
                onQuick={quickSend}
                hint="@all 广播 · 全局会话跨群共享上下文"
              />
            </>
          ) : (
            <>
              <DmHeader member={member!} session={sessionOf(member!)} onAction={pushToast} />
              <MessageList msgs={msgs} />
              <Composer
                mentionable={[]}
                placeholder={`发送私聊消息给 ${member!.name}…`}
                quick={quickDm}
                onQuick={quickSend}
                hint="私聊 · 全局会话（跨群共享上下文）"
              />
            </>
          )}
        </div>

        {/* 右栏：群聊态 Tab / 私聊态成员信息卡 */}
        {team ? (
          <TeamRightPanel
            team={team}
            tab={tab}
            onTab={setTab}
            onOpenDm={(id) => selectConv(id)}
            onAction={pushToast}
          />
        ) : (
          <MemberRightPanel
            member={member!}
            session={sessionOf(member!)}
            onResetSession={() => setSessionResetFor(member!.id)}
            onAction={pushToast}
          />
        )}
      </div>

      {/* 左侧悬浮 Dock（消息中心高亮） */}
      {/* 重置全局会话二次确认（absolute 居中，z-45；影响该成员所有群聊上下文） */}
      {sessionResetFor && MEMBER_MAP[sessionResetFor] && (
        <SessionResetModal
          member={MEMBER_MAP[sessionResetFor]}
          session={sessionOf(MEMBER_MAP[sessionResetFor])}
          onCancel={() => setSessionResetFor(null)}
          onConfirm={() => resetGlobalSession(MEMBER_MAP[sessionResetFor])}
        />
      )}

      <NavDock activeKey="messages" projectName="Agent 协作平台" />

      {/* 新建群聊浮层（绝对定位在当前容器内，z-30） */}
      {newGroupOpen && (
        <NewGroupPopover onClose={() => setNewGroupOpen(false)} onToast={pushToast} />
      )}

      {/* 轻提示（绝对定位，点击关闭）：原型内所有「示意」操作的反馈承载 */}
      {toast && !newGroupOpen && (
        <div
          data-testid="toast"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            zIndex: 20,
            maxWidth: 640,
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.pill,
            backgroundColor: "rgba(15,23,42,.9)",
            color: "#F8FAFC",
            fontSize: fontSize.xs,
            boxShadow: shadow.md,
            animation: "wc-pop .16s ease-out",
            ...baseFont,
          }}
        >
          <span>{toast}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.sm,
              cursor: "pointer",
              lineHeight: 1,
              padding: 0,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Cmd+K 命令面板（受控） */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "wechat-chat",
    name: "微信式会话",
    group: "消息协作",
    description:
      "成员与群聊平铺的微信式会话页：左侧双类型会话列表、群聊成员切换条、私聊成员信息卡与右侧栏随会话切换",
    device: "desktop",
  },
  Component: WechatChat,
};

export default def;
