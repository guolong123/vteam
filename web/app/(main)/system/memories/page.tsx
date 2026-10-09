"use client";

/**
 * 记忆管理页（Todo 6：mem-web；2026-09-30 卡片网格 + 详情抽屉 + 角色级 + 自动注入开关）
 * =============================================================================
 * - 列表形态：**响应式卡片网格**（auto-fill / minmax(320px,1fr)）+ 右侧详情抽屉；
 *   旧版「竖排行 + 行内展开」已下线（展开会把标题顶掉，且记忆正文普遍 400~1200 字）。
 * - 标签体系：`howto / pitfall / constraint` 三类**类型标签** → 实心着色类型芯片；
 *   其余主题词 → 中性描边芯片（>6 折叠为 +N）。无类型标签则不渲染类型芯片。
 * - 归属信息：teamId → 团队名；createdBy（tmm_）→ 成员 alias + agent 名
 *   （**一次 teams 查询同时解析团队名与成员别名**，绝不把 tmm_ 裸 id 渲染给用户）。
 * - 级别筛选 tab（全部 / 团队 / 角色 / 全局）+ keyword 搜索（防抖 300ms）+ 分页 + 删除
 * - 数据源：GET /api/v1/memories（level / keyword / page / pageSize 过滤，AdminGuard）
 * - 铁律（T15）：无 fixed 定位、无视口尺寸单位（vh/vw）；抽屉为 absolute 浮层
 *   （宿主 = 页面根 flex 容器 `position:relative`，滚动发生在其内层 overflow:auto，
 *   与 board 页 TaskDetailDrawer 同构）+ 遮罩点击关闭 + Esc 关闭。
 *
 * ⚠ 无「任务」级别 Tab：任务级记忆已删除（session-unification Todo 9），
 *   后端 level=task → 400 MEMORY_LEVEL_INVALID。
 *
 * ⚠ `autoInject` 是**单条记忆的属性**（卡片右上角开关 + 抽屉底部开关），不是筛选维度，
 *   故不做成独立 tab；`level=role` 的卡片额外显示归属岗位名（roleId → /agent-roles）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/errors";
import {
  ConfirmDialog,
  EmptyState,
  Markdown,
  SegmentedTabs,
} from "@/src/components/ui";
import { agentRolesApi, type AgentRoleDto } from "@/src/api/agent-roles";
import {
  memoriesApi,
  memoriesQueryKey,
  type MemoriesResponse,
  type MemoryItem,
} from "@/src/api/memories";
import { teamsApi } from "@/src/api/teams";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
  surface,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ API 数据模型 ------------------------------ */

/** 团队成员引用（teams 查询解析 createdBy 得到的展示信息）。 */
interface MemberRef {
  /** 成员别名（唯一面向用户的标识，绝不展示 tmm_ 裸 id）。 */
  alias: string;
  /** 关联 agent 名（可空：成员未绑定 agent 模板）。 */
  agentName: string | null;
}

/** 创建者展示形态（`createdBy` 的 id 前缀 + `sourceType` 共同决定）。 */
interface CreatorRef {
  /** 主文本：成员别名 / 「系统内置」/「用户」/「未知创建者」。 */
  label: string;
  /** 副文本：agent 名等补充说明，可空。 */
  detail: string | null;
}

/**
 * 解析创建者展示。**不能一律按 `tmm_` 查成员表**——线上实测 35 条里有 1 条
 * `me_team_collab_charter` 是 seed 写的 `sourceType=system` + `createdBy=u_seed_admin`
 * （用户 id 而非成员 id），按成员查会落到「未知创建者」，而它恰是团队协作章程这行关键数据。
 * 故先按 sourceType 判系统来源，再按 id 前缀分流；用户 id 不额外查 /users
 * （全库仅此 1 条，且无 users 查询封装），泛化为「用户」即可。
 */
function resolveCreator(
  memory: MemoryItem,
  member: MemberRef | undefined,
): CreatorRef {
  if (memory.sourceType === "system") {
    return { label: "系统内置", detail: null };
  }
  if (member) {
    return { label: member.alias, detail: member.agentName };
  }
  if (memory.createdBy.startsWith("u_")) {
    return { label: "用户", detail: null };
  }
  return { label: "未知创建者", detail: null };
}

/* ------------------------------ 级别筛选 Tab ------------------------------ */

type LevelFilter = "" | "team" | "role" | "global";

const LEVEL_TABS: { key: LevelFilter; label: string; icon: string }[] = [
  { key: "", label: "全部", icon: "◈" },
  { key: "team", label: "团队", icon: "◨" },
  { key: "role", label: "角色", icon: "◉" },
  { key: "global", label: "全局", icon: "◎" },
];

/** 级别 → 徽章配色（对齐 tokens 语义色系；任务级已删除）。color 同时作卡片左侧色条。 */
const LEVEL_META: Record<
  MemoryItem["level"],
  { label: string; color: string; bg: string; border: string }
> = {
  team: {
    label: "团队",
    color: "#7C3AED",
    bg: "rgba(124,58,237,0.10)",
    border: "rgba(124,58,237,0.22)",
  },
  role: {
    label: "角色",
    color: "#0D9488",
    bg: "rgba(13,148,136,0.10)",
    border: "rgba(13,148,136,0.26)",
  },
  global: {
    label: "全局",
    color: "#059669",
    bg: "rgba(16,185,129,0.10)",
    border: "rgba(16,185,129,0.28)",
  },
};

/** 各级自动注入的受众说明（开关的 title 提示）。 */
const LEVEL_AUDIENCE: Record<MemoryItem["level"], string> = {
  team: "自动注入给本团队主 Agent",
  role: "自动注入给本团队该岗位的全部 agent",
  global: "自动注入给各团队主 Agent",
};

/* ------------------------------ 类型标签（记忆分类法） ------------------------------ */

/**
 * 平台记忆分类法的三个**类型标签**（与自由主题词区分）：
 * howto = 怎么做 / pitfall = 坑与规避 / constraint = 平台硬约束。
 * 渲染为**实心着色芯片**（有色底 + 有色边 + 有色字），
 * 与中性描边的主题芯片形成「不同类元素」的视觉区分；一条记忆可同时带多个类型标签。
 */
const TYPE_TAGS = ["howto", "pitfall", "constraint"] as const;
type MemoryTypeTag = (typeof TYPE_TAGS)[number];

const TYPE_META: Record<
  MemoryTypeTag,
  { label: string; color: string; bg: string; border: string }
> = {
  howto: {
    label: "做法",
    color: "#0284C7",
    bg: "rgba(2,132,199,0.10)",
    border: "rgba(2,132,199,0.24)",
  },
  pitfall: {
    label: "坑",
    color: "#B45309",
    bg: "rgba(217,119,6,0.12)",
    border: "rgba(217,119,6,0.26)",
  },
  constraint: {
    label: "约束",
    color: "#BE123C",
    bg: "rgba(225,29,72,0.10)",
    border: "rgba(225,29,72,0.24)",
  },
};

const TYPE_TAG_SET: ReadonlySet<string> = new Set<string>(TYPE_TAGS);

/* ------------------------------ 布局 / 配色常量 ------------------------------ */

/** 网格最小列宽：低于此宽度退化为单列全宽（无需媒体查询）。 */
const GRID_MIN_COL = 320;
/** 抽屉宽度（对齐 TaskDetailDrawer）。 */
const DRAWER_WIDTH = 440;
/** 抽屉正文块最大高度：超出内部滚动（记忆正文 400~1200 字，含代码块）。 */
const DRAWER_BODY_MAX_H = 420;
/** 单卡片主题标签最多渲染个数，超出折叠为 +N。 */
const MAX_TOPIC_TAGS = 6;
/** 自动注入开关主色（与 LEVEL_META.role 同源的品牌青）。 */
const INJECT_ON = "#0D9488";
/** 自动注入开关「关」态轨道（同色 0.22 透明度）。 */
const INJECT_OFF_TRACK = "rgba(13,148,136,0.22)";

/* ------------------------------ 纯函数工具 ------------------------------ */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 多行截断（-webkit-box clamp）。 */
function lineClamp(lines: number): CSSProperties {
  return {
    display: "-webkit-box",
    WebkitLineClamp: lines,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  };
}

/**
 * 拆分 tags：类型标签（→ 实心类型芯片）与主题标签（→ 中性描边芯片）。
 * tags 来自 JSON 列，做运行时兜底（非法元素跳过而非崩溃）。
 */
function splitTags(tags: string[] | null | undefined): {
  types: MemoryTypeTag[];
  topics: string[];
} {
  const types: MemoryTypeTag[] = [];
  const topics: string[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = typeof raw === "string" ? raw.trim() : "";
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (TYPE_TAG_SET.has(key)) {
      const type = key as MemoryTypeTag;
      if (!types.includes(type)) types.push(type);
    } else if (!topics.includes(tag)) {
      topics.push(tag);
    }
  }
  return { types, topics };
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前（7 天内）/ M月D日。 */
function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "时间未知";
  const diff = now - ts;
  if (diff < MINUTE_MS) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 卡片标题：优先 description（模型摘要），否则 content 前 60 字。 */
function cardTitle(memory: MemoryItem): string {
  return memory.description?.trim() || memory.content.slice(0, 60);
}

/** 抽屉标题：description 优先，否则 content 首个非空行（全文展示，不截断）。 */
function detailTitle(memory: MemoryItem): string {
  const desc = memory.description?.trim();
  if (desc) return desc;
  const firstLine = memory.content
    .split("\n")
    .find((line) => line.trim().length > 0);
  return firstLine?.trim() || "未命名记忆";
}

/* ------------------------------ 卡片 hover CSS ------------------------------ */

const cardCss = `
.mem-card { transition: box-shadow .15s ease, border-color .15s ease, transform .15s ease; }
.mem-card:hover { box-shadow: ${shadow.md}; transform: translateY(-2px); }
.mem-open:focus-visible { box-shadow: inset 0 0 0 2px ${neutral[400]}; }
`;

/* ================================ 通用小组件 ================================ */

/** 类型芯片（实心着色）：一条记忆可带多个类型标签；无类型标签则整块不渲染。 */
function TypeChips({ tags }: { tags: string[] | null | undefined }) {
  const { types } = splitTags(tags);
  if (types.length === 0) return null;
  return (
    <>
      {types.map((type) => {
        const meta = TYPE_META[type];
        return (
          <span
            key={type}
            data-testid="memory-type-badge"
            data-type={type}
            title={type}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.pill,
              backgroundColor: meta.bg,
              border: `1px solid ${meta.border}`,
              color: meta.color,
              fontSize: fontSize.xs,
              fontWeight: 500,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {meta.label}
          </span>
        );
      })}
    </>
  );
}

/** 主题标签芯片（中性描边）：最多 max 个，超出折叠为 +N；无主题标签则不渲染。 */
function TopicChips({
  tags,
  max = MAX_TOPIC_TAGS,
}: {
  tags: string[] | null | undefined;
  max?: number;
}) {
  const { topics } = splitTags(tags);
  if (topics.length === 0) return null;
  const shown = topics.slice(0, max);
  const rest = topics.length - shown.length;
  const chip: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: `1px ${space.sm}px`,
    borderRadius: radius.pill,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "transparent",
    color: neutral[500],
    fontSize: fontSize.xs,
    lineHeight: 1.5,
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
      {shown.map((tag) => (
        <span key={tag} style={chip}>
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span style={chip} title={topics.slice(max).join("、")}>
          +{rest}
        </span>
      )}
    </div>
  );
}

/** 级别徽章（团队 / 角色 / 全局）：实心着色胶囊 + 级别色圆点。 */
function LevelBadge({ level }: { level: MemoryItem["level"] }) {
  const meta = LEVEL_META[level];
  return (
    <span
      data-testid="memory-level-badge"
      data-level={level}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: meta.bg,
        border: `1px solid ${meta.border}`,
        color: meta.color,
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: meta.color,
          flexShrink: 0,
        }}
      />
      {meta.label}
    </span>
  );
}

/** 角色级记忆的归属岗位徽章（仅 level=role）：展示岗位**名**（缺失时回落 roleId）。 */
function RoleBadge({
  roleId,
  name,
}: {
  roleId: string;
  name: string | undefined;
}) {
  return (
    <span
      data-testid="memory-role-badge"
      title={`岗位 ID：${roleId}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        color: neutral[600],
        fontSize: fontSize.xs,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {name ?? roleId}
    </span>
  );
}

interface AutoInjectSwitchProps {
  memory: MemoryItem;
  /** 该条在途（in-flight）时禁用。 */
  disabled: boolean;
  onToggle: (memory: MemoryItem) => void;
}

/**
 * 自动注入开关：轨道 + 滑块 + 左侧 10px 状态文案。
 * 点击必须 `stopPropagation`：开关嵌在卡片内，不能连带触发卡片打开抽屉。
 */
function AutoInjectSwitch({
  memory,
  disabled,
  onToggle,
}: AutoInjectSwitchProps) {
  const on = memory.autoInject;
  return (
    <button
      type="button"
      data-testid="memory-auto-inject-toggle"
      data-memory-id={memory.id}
      data-auto-inject={on ? "true" : "false"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(memory);
      }}
      title={
        on
          ? `已开启自动注入（${LEVEL_AUDIENCE[memory.level]}）——点击关闭，改为仅按需检索`
          : `已关闭自动注入（仅 memory_search 按需检索）——点击开启，每轮注入（${LEVEL_AUDIENCE[memory.level]}）`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        flexShrink: 0,
        padding: 0,
        border: "none",
        backgroundColor: "transparent",
        cursor: disabled ? "wait" : "pointer",
        fontFamily: fontFamily.body,
        lineHeight: 1,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: on ? INJECT_ON : neutral[400],
          whiteSpace: "nowrap",
        }}
      >
        {on ? "自动注入" : "按需检索"}
      </span>
      <span
        aria-hidden
        style={{
          position: "relative",
          display: "inline-block",
          width: 34,
          height: 18,
          flexShrink: 0,
          borderRadius: radius.pill,
          backgroundColor: on ? INJECT_ON : INJECT_OFF_TRACK,
          transition: "background-color .15s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            // 开启时轨道与滑块都用 INJECT_ON 会让滑块消失在轨道里（看着像没有开关），
            // 故滑块固定用中性浅色，靠位置（left 2→18）表达开合。
            backgroundColor: on ? neutral[50] : neutral[300],
            transition: "left .15s ease",
          }}
        />
      </span>
    </button>
  );
}

/* ================================ 记忆卡片 ================================ */

interface MemoryCardProps {
  memory: MemoryItem;
  /** 已解析的归属团队名（无 teamId 时为「公共」）。 */
  teamName: string;
  /** 已解析的创建者（未命中 teams 成员表时为 undefined）。 */
  member: MemberRef | undefined;
  /** roleId → 岗位名（仅 level=role 用）。 */
  roleName: string | undefined;
  /** 自动注入开关是否禁用（在途）。 */
  injectDisabled: boolean;
  onOpen: (id: string) => void;
  onToggleInject: (memory: MemoryItem) => void;
}

/** 单条记忆卡片：左侧级别色条 + 类型芯片/开关 + 标题 + 正文预览 + 元信息 + 主题标签。 */
function MemoryCard({
  memory,
  teamName,
  member,
  roleName,
  injectDisabled,
  onOpen,
  onToggleInject,
}: MemoryCardProps) {
  const title = cardTitle(memory);
  const creator = resolveCreator(memory, member);
  const createdByTip = member?.agentName
    ? `${memory.createdBy}（${member.agentName}）`
    : memory.createdBy;
  const createdAtFull = new Date(memory.createdAt).toLocaleString("zh-CN");

  return (
    <div
      data-testid="memory-item"
      data-memory-id={memory.id}
      data-level={memory.level}
      className="mem-card"
      style={{
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: space.lg,
        borderRadius: radius.lg,
        backgroundColor: surface,
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      {/* ① 左侧级别色条（overflow:hidden + borderRadius 跟随卡片圆角） */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          backgroundColor: LEVEL_META[memory.level].color,
        }}
      />

      <div
        data-testid="memory-card-open"
        className="mem-open"
        role="button"
        tabIndex={0}
        aria-label={`查看记忆详情：${title}`}
        onClick={() => onOpen(memory.id)}
        onKeyDown={(e) => {
          // 只处理卡片自身获得焦点时的回车/空格；开关内的按键交由开关处理（不冒泡开抽屉）
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onOpen(memory.id);
          }
        }}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          cursor: "pointer",
        }}
      >
        {/* ② 顶部：类型芯片（左） + 自动注入开关（右） */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.xs,
              flexWrap: "wrap",
              minWidth: 0,
            }}
          >
            <TypeChips tags={memory.tags} />
            {memory.level === "role" && memory.roleId && (
              <RoleBadge roleId={memory.roleId} name={roleName} />
            )}
          </div>
          <AutoInjectSwitch
            memory={memory}
            disabled={injectDisabled}
            onToggle={onToggleInject}
          />
        </div>

        {/* ③ 标题（永远存在，不被正文抢占） */}
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            lineHeight: 1.5,
            wordBreak: "break-word",
            ...lineClamp(2),
          }}
        >
          {title}
        </div>

        {/* ④ 正文预览（4 行截断，全文见抽屉） */}
        <div
          data-testid="memory-body-preview"
          style={{
            fontSize: fontSize.sm,
            color: neutral[500],
            lineHeight: 1.6,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            ...lineClamp(4),
          }}
        >
          {memory.content}
        </div>

        {/* ⑤ 分隔线 */}
        <div
          aria-hidden
          style={{ height: 1, backgroundColor: neutral[100], flexShrink: 0 }}
        />

        {/* ⑥ 元信息：级别 · 团队 · 创建人 · 相对时间 · 字数 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xs,
            flexWrap: "wrap",
            fontSize: fontSize.xs,
            color: neutral[400],
            lineHeight: 1.6,
          }}
        >
          <LevelBadge level={memory.level} />
          <span aria-hidden>·</span>
          <span style={{ whiteSpace: "nowrap" }}>{teamName}</span>
          <span aria-hidden>·</span>
          <span
            data-testid="memory-created-by"
            title={createdByTip}
            style={{ cursor: "help" }}
          >
            {creator.label}
            {creator.detail ? `（${creator.detail}）` : ""}
          </span>
          <span aria-hidden>·</span>
          <span
            data-testid="memory-created-at"
            title={createdAtFull}
            style={{ cursor: "help", whiteSpace: "nowrap" }}
          >
            {formatRelativeTime(memory.createdAt)}
          </span>
          <span aria-hidden>·</span>
          <span style={{ whiteSpace: "nowrap" }}>
            {memory.content.length} 字
          </span>
        </div>

        {/* ⑦ 主题标签 */}
        <TopicChips tags={memory.tags} />
      </div>
    </div>
  );
}

/* ================================ 详情抽屉 ================================ */

interface MemoryDetailDrawerProps {
  memory: MemoryItem | null;
  teamName: string;
  member: MemberRef | undefined;
  roleName: string | undefined;
  injectDisabled: boolean;
  onToggleInject: (memory: MemoryItem) => void;
  onDelete: (memory: MemoryItem) => void;
  onClose: () => void;
}

/**
 * 记忆详情抽屉：absolute 浮层（宿主为页面根 flex 容器 position:relative）+ 遮罩 + Esc 关闭，
 * 面板固定右侧、宽 440（逐项对齐 TaskDetailDrawer）。
 */
function MemoryDetailDrawer({
  memory,
  teamName,
  member,
  roleName,
  injectDisabled,
  onToggleInject,
  onDelete,
  onClose,
}: MemoryDetailDrawerProps) {
  useEffect(() => {
    if (!memory) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [memory, onClose]);

  if (!memory) return null;
  const creator = resolveCreator(memory, member);

  const metaRow: CSSProperties = {
    display: "flex",
    gap: space.xs,
    wordBreak: "break-word",
  };
  const metaKey: CSSProperties = { color: neutral[400], flexShrink: 0 };

  return (
    <div
      data-testid="memory-drawer"
      data-memory-id={memory.id}
      data-level={memory.level}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, zIndex: 50, ...baseFont }}
    >
      {/* 遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="memory-drawer-backdrop"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(15,23,42,.32)",
        }}
      />

      <aside
        role="dialog"
        aria-label="记忆详情"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          maxWidth: "calc(100% - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          overflow: "auto",
          backgroundColor: surface,
          borderLeft: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        {/* 标题区 + 关闭按钮 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: fontSize.xs,
                color: neutral[400],
                fontFamily: fontFamily.mono,
              }}
            >
              {memory.id}
            </div>
            <div
              style={{
                fontSize: fontSize.xl,
                fontWeight: 600,
                color: neutral[900],
                lineHeight: 1.3,
                marginTop: space.xs,
                wordBreak: "break-word",
              }}
            >
              {detailTitle(memory)}
            </div>
          </div>
          <button
            type="button"
            data-testid="memory-drawer-close"
            onClick={onClose}
            aria-label="关闭"
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: surface,
              color: neutral[600],
              cursor: "pointer",
              fontFamily: fontFamily.body,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* 类型芯片 + 级别 + 团队 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            flexWrap: "wrap",
          }}
        >
          <TypeChips tags={memory.tags} />
          <LevelBadge level={memory.level} />
          <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
            {teamName}
          </span>
          {memory.level === "role" && memory.roleId && (
            <RoleBadge roleId={memory.roleId} name={roleName} />
          )}
        </div>

        {/* 元信息块 */}
        <div
          data-testid="memory-drawer-meta"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.6,
          }}
        >
          <div style={metaRow}>
            <span style={metaKey}>记忆 ID：</span>
            <span style={{ fontFamily: fontFamily.mono, color: neutral[700] }}>
              {memory.id}
            </span>
          </div>
          <div style={metaRow}>
            <span style={metaKey}>级别：</span>
            <span>{LEVEL_META[memory.level].label}</span>
          </div>
          <div style={metaRow}>
            <span style={metaKey}>团队：</span>
            <span>{teamName}</span>
          </div>
          <div style={metaRow}>
            <span style={metaKey}>创建人：</span>
            <span title={memory.createdBy}>
              {creator.label}
              {creator.detail ? `（${creator.detail}）` : ""}
            </span>
          </div>
          <div style={metaRow}>
            <span style={metaKey}>创建时间：</span>
            <span>{new Date(memory.createdAt).toLocaleString("zh-CN")}</span>
          </div>
          <div style={metaRow}>
            <span style={metaKey}>字数：</span>
            <span>{memory.content.length} 字</span>
          </div>
          {memory.roleId ? (
            <div style={metaRow}>
              <span style={metaKey}>岗位 ID：</span>
              <span
                style={{ fontFamily: fontFamily.mono, color: neutral[700] }}
              >
                {memory.roleId}
                {roleName ? `（${roleName}）` : ""}
              </span>
            </div>
          ) : null}
        </div>

        {/* 正文全文（Markdown；超长内部滚动） */}
        <div
          data-testid="memory-drawer-body"
          style={{
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: surface,
            fontSize: fontSize.md,
            color: neutral[800],
            maxHeight: DRAWER_BODY_MAX_H,
            overflow: "auto",
          }}
        >
          <Markdown>{memory.content}</Markdown>
        </div>

        {/* 主题标签 */}
        <TopicChips tags={memory.tags} />

        {/* 底部操作：自动注入开关 + 删除 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.md,
            paddingTop: space.md,
            borderTop: `1px solid ${neutral[100]}`,
          }}
        >
          <AutoInjectSwitch
            memory={memory}
            disabled={injectDisabled}
            onToggle={onToggleInject}
          />
          <button
            type="button"
            data-testid="memory-delete-button"
            data-memory-id={memory.id}
            onClick={() => onDelete(memory)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: surface,
              color: neutral[600],
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              transition:
                "color .15s ease, border-color .15s ease, background-color .15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#DC2626";
              e.currentTarget.style.borderColor = "rgba(239,68,68,0.22)";
              e.currentTarget.style.backgroundColor = "rgba(239,68,68,0.10)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = neutral[600];
              e.currentTarget.style.borderColor = neutral[200];
              e.currentTarget.style.backgroundColor = surface;
            }}
          >
            删除
          </button>
        </div>
      </aside>
    </div>
  );
}

/* ================================ 页面组件 ================================ */

export default function MemoriesPage() {
  const queryClient = useQueryClient();

  /* ---------- 状态 ---------- */
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  /** 抽屉当前记忆（null = 抽屉关闭）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* ---------- 防抖 300ms ---------- */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /* ---------- 切换筛选：重置页码并关闭抽屉 ---------- */
  useEffect(() => {
    setPage(1);
    setSelectedId(null);
  }, [levelFilter]);

  /* ---------- 翻页 / 搜索变化：关闭抽屉 ---------- */
  useEffect(() => {
    setSelectedId(null);
  }, [debouncedKeyword, page]);

  /* ---------- 数据查询 ---------- */
  const memoriesQuery = useQuery<MemoriesResponse>({
    queryKey: memoriesQueryKey({
      level: levelFilter || undefined,
      keyword: debouncedKeyword,
      page,
      pageSize,
    }),
    queryFn: () =>
      memoriesApi.list({
        ...(levelFilter ? { level: levelFilter } : {}),
        ...(debouncedKeyword ? { keyword: debouncedKeyword } : {}),
        page,
        pageSize,
      }),
  });

  /* ---------- 岗位名解析（role 级记忆显示归属岗位） ---------- */
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });
  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of (rolesQuery.data?.items ?? []) as AgentRoleDto[]) {
      map.set(r.id, r.name);
    }
    return map;
  }, [rolesQuery.data]);

  /* ---------- 团队解析（团队名 + 成员别名，createdBy 为 tmm_ 成员 id） ---------- */
  const teamsQuery = useQuery({
    queryKey: ["teams", "memory-attribution"],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    staleTime: 5 * 60 * 1000,
  });
  const { teamNameById, memberById } = useMemo(() => {
    const teamNames = new Map<string, string>();
    const members = new Map<string, MemberRef>();
    for (const team of teamsQuery.data?.items ?? []) {
      teamNames.set(team.id, team.name);
      for (const member of team.members ?? []) {
        members.set(member.id, {
          alias: member.alias,
          agentName: member.agent?.name ?? null,
        });
      }
    }
    return { teamNameById: teamNames, memberById: members };
  }, [teamsQuery.data]);

  useEffect(() => {
    if (!teamsQuery.error) return;
    console.error("[MemoriesPage] GET /teams failed", teamsQuery.error);
  }, [teamsQuery.error]);

  /* ---------- 自动注入开关（单条记忆属性，卡片 + 抽屉共用） ---------- */
  const [pendingInject, setPendingInject] = useState<string | null>(null);
  const injectMutation = useMutation({
    mutationFn: (input: { id: string; autoInject: boolean }) =>
      memoriesApi.setAutoInject(input.id, input.autoInject),
    onMutate: (input) => {
      setPendingInject(input.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
    onSettled: () => {
      setPendingInject(null);
    },
  });
  const toggleInject = (memory: MemoryItem) => {
    injectMutation.mutate({ id: memory.id, autoInject: !memory.autoInject });
  };

  /* ---------- 删除 ---------- */
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (id: string) => memoriesApi.archive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      setDeleteTarget(null);
      setSelectedId(null);
    },
  });

  /* ---------- 分页 ---------- */
  const totalPages = useMemo(() => {
    const total = memoriesQuery.data?.total ?? 0;
    return Math.max(1, Math.ceil(total / pageSize));
  }, [memoriesQuery.data?.total, pageSize]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage >= 1 && newPage <= totalPages) setPage(newPage);
    },
    [totalPages],
  );

  /* ---------- 计算 ---------- */
  const items = memoriesQuery.data?.items ?? [];
  const total = memoriesQuery.data?.total ?? 0;
  const selected = items.find((item) => item.id === selectedId) ?? null;

  /** 归属团队名（无 teamId 的全局记忆标为「公共」；团队查不到时不泄漏裸 teamId）。 */
  const teamNameOf = (memory: MemoryItem) => {
    if (!memory.teamId) return "公共";
    return teamNameById.get(memory.teamId) ?? "未知团队";
  };

  const errorBanner: CSSProperties = {
    fontSize: fontSize.sm,
    color: "#DC2626",
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radius.md,
    backgroundColor: "rgba(239,68,68,0.10)",
    border: `1px solid rgba(239,68,68,0.22)`,
  };

  /* 宿主结构照 board 页（TaskDetailDrawer 同款）：外层 flex:1 + minHeight:0 + position:relative
     作为抽屉 absolute 浮层的 containing block，**滚动发生在内层 overflow:auto**。
     若像之前那样把宿主直接交给 PageWindow（无 overflow、高度随内容涨到几千 px），
     `inset:0` 会覆盖整个文档，滚动到下方点卡片时面板 top:0 落在视口之外 ——
     抽屉的标题/芯片/关闭按钮被滚出屏幕，只剩中段正文。铁律 T15 禁 fixed，故用 flex 高度链。 */
  return (
    <div
      data-testid="memories-page"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        ...baseFont,
      }}
    >
      <style>{cardCss}</style>

      {/* 内容滚动层：与 board 的 task-board-root 内层同构 */}
      <div
        data-testid="memories-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: `${space.xl}px ${space.xxl}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1400,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* ① 工具条：级别 Tab + 搜索框 */}
          <div
            data-testid="manage-toolbar"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.lg,
              flexWrap: "wrap",
            }}
          >
            {/* 级别 Tab（共享 ui/SegmentedTabs，与 skills 页同式） */}
            <SegmentedTabs
              items={LEVEL_TABS}
              active={levelFilter}
              onChange={(k) => setLevelFilter(k as LevelFilter)}
            />

            {/* 搜索框（防抖 300ms） */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                flex: 1,
                minWidth: 220,
                maxWidth: 320,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: surface,
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
                marginLeft: "auto",
              }}
            >
              <span
                aria-hidden
                style={{
                  fontSize: fontSize.lg,
                  color: neutral[400],
                  lineHeight: 1,
                }}
              >
                ⌕
              </span>
              <input
                data-testid="memory-search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索记忆内容…"
                aria-label="搜索记忆"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontFamily: fontFamily.body,
                }}
              />
            </div>
          </div>

          {/* ② 内容区域 */}
          {memoriesQuery.isPending ? (
            <div
              data-testid="memories-loading"
              style={{
                fontSize: fontSize.md,
                color: neutral[400],
                padding: `${space.xxl}px 0`,
                textAlign: "center",
              }}
            >
              加载中…
            </div>
          ) : memoriesQuery.isError ? (
            <div
              data-testid="memories-error"
              role="alert"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: space.md,
                padding: `${space.xl}px`,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
                {isApiError(memoriesQuery.error)
                  ? memoriesQuery.error.message
                  : "加载记忆列表失败"}
              </div>
              <button
                type="button"
                data-testid="memories-retry"
                onClick={() => memoriesQuery.refetch()}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: surface,
                  color: neutral[600],
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <div data-testid="memories-empty">
              <EmptyState
                icon={<span aria-hidden>◈</span>}
                title={debouncedKeyword ? "未找到匹配的记忆" : "暂无记忆数据"}
                description={
                  debouncedKeyword
                    ? "换个关键词试试，或切回「全部」标签。"
                    : "Agent 在协作过程中沉淀的记忆会出现在这里。"
                }
              />
            </div>
          ) : (
            <>
              {/* 计数 */}
              <div
                data-testid="memories-count"
                style={{ fontSize: fontSize.sm, color: neutral[400] }}
              >
                共 {total} 条记忆
              </div>

              {/* 卡片网格 */}
              <div
                data-testid="memories-list"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.md,
                }}
              >
                <div
                  data-testid="memory-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(auto-fill, minmax(${GRID_MIN_COL}px, 1fr))`,
                    gap: space.lg,
                  }}
                >
                  {items.map((item) => (
                    <MemoryCard
                      key={item.id}
                      memory={item}
                      teamName={teamNameOf(item)}
                      member={memberById.get(item.createdBy)}
                      roleName={
                        item.roleId ? roleNameById.get(item.roleId) : undefined
                      }
                      injectDisabled={
                        pendingInject === item.id || injectMutation.isPending
                      }
                      onOpen={setSelectedId}
                      onToggleInject={toggleInject}
                    />
                  ))}
                </div>
              </div>

              {/* 分页 */}
              {totalPages > 1 && (
                <div
                  data-testid="memories-pagination"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: space.sm,
                    marginTop: space.md,
                  }}
                >
                  <button
                    type="button"
                    data-testid="page-prev"
                    disabled={page <= 1}
                    onClick={() => handlePageChange(page - 1)}
                    style={{
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: surface,
                      color: page <= 1 ? neutral[300] : neutral[600],
                      fontSize: fontSize.sm,
                      cursor: page <= 1 ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    上一页
                  </button>
                  <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    data-testid="page-next"
                    disabled={page >= totalPages}
                    onClick={() => handlePageChange(page + 1)}
                    style={{
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: surface,
                      color: page >= totalPages ? neutral[300] : neutral[600],
                      fontSize: fontSize.sm,
                      cursor: page >= totalPages ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}

          {/* 自动注入开关失败提示（内联） */}
          {injectMutation.isError && (
            <div
              data-testid="memory-auto-inject-error"
              role="alert"
              style={errorBanner}
            >
              <span aria-hidden style={{ fontWeight: 700 }}>
                !
              </span>
              {isApiError(injectMutation.error)
                ? injectMutation.error.message
                : "切换自动注入失败，请重试"}
            </div>
          )}

          {/* 删除失败提示（内联，对齐 agents 页错误显示模式） */}
          {deleteMutation.isError && (
            <div
              data-testid="memory-delete-error"
              role="alert"
              style={errorBanner}
            >
              <span aria-hidden style={{ fontWeight: 700 }}>
                !
              </span>
              {isApiError(deleteMutation.error)
                ? deleteMutation.error.message
                : "删除失败，请重试"}
            </div>
          )}
        </div>
      </div>

      {/* 详情抽屉：与滚动层同级（宿主直接子级），随宿主定位、不随内容滚动 */}
      <MemoryDetailDrawer
        memory={selected}
        teamName={selected ? teamNameOf(selected) : ""}
        member={selected ? memberById.get(selected.createdBy) : undefined}
        roleName={
          selected?.roleId ? roleNameById.get(selected.roleId) : undefined
        }
        injectDisabled={
          !!selected &&
          (pendingInject === selected.id || injectMutation.isPending)
        }
        onToggleInject={toggleInject}
        onDelete={(memory) => setDeleteTarget(memory)}
        onClose={() => setSelectedId(null)}
      />

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={!!deleteTarget}
        testid="confirm-delete-memory"
        title="删除记忆"
        description={`确定要删除这条${deleteTarget ? LEVEL_META[deleteTarget.level].label : ""}级记忆吗？此操作不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        danger
        submitting={deleteMutation.isPending}
        onClose={() => {
          setDeleteTarget(null);
          deleteMutation.reset();
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
