/**
 * 记忆展示原子组件与纯工具（团队「记忆」子 Tab 卡片 + 详情弹窗共用）
 * =============================================================
 * 抽出来的原因：卡片（TeamMemoriesTab）与详情弹窗（TeamMemoryDetailModal）要显示
 * **同一套**芯片/徽标/相对时间口径（对齐 /system/memories 管理页）。留在任一文件里
 * 都会让另一处要么复制一份（漂移），要么反向 import 形成循环依赖。
 *
 * 全部只读展示：不取数、不管权限、不含操作按钮。
 */
import type { CSSProperties } from "react";
import type { MemoryItem, MemoryLevel } from "@/src/api/memories";
import {
  neutral,
  space,
  radius,
  fontSize,
  surface,
} from "@/src/theme/tokens";

/** 主题标签最多渲染个数，超出折叠为 +N。 */
export const MAX_TOPIC_TAGS = 6;

/** 品牌青：自动注入开启态 / 引用计数强调色（与管理页同源）。 */
const INJECT_ON = "#0D9488";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* ------------------------------ 纯函数工具 ------------------------------ */

/** 平台记忆分类法的三个类型标签 → 实心着色；其余主题词 → 中性描边芯片。 */
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

/** 记忆级别中文名（管理页 LEVEL_META.label 同口径）。 */
const LEVEL_LABEL: Record<MemoryLevel, string> = {
  team: "团队级",
  role: "岗位级",
  global: "全局（平台级）",
};

/** 拆分 tags：类型标签（实心）与主题词（中性描边）；非法元素跳过而非崩溃。 */
export function splitTags(tags: string[] | null | undefined): {
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

/** 记忆级别徽标文本（无标签时返回 null）。 */
export function levelLabel(level: MemoryLevel): string {
  return LEVEL_LABEL[level] ?? level;
}

/** 绝对时间短标签（无效/缺失返回「—」）。 */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("zh-CN") : "—";
}

/** 引用次数安全化（非有限/负数 → 0），卡片徽标与详情元信息共用。 */
export function safeRefCount(memory: Pick<MemoryItem, "refCount">): number {
  return Number.isFinite(memory.refCount) ? Math.max(0, Math.trunc(memory.refCount)) : 0;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前（7 天内）/ M月D日。 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now()
): string {
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

/* ------------------------------ 展示原子 ------------------------------ */

/** 类型芯片（实心着色）；无类型标签则整块不渲染。 */
export function TypeChips({ tags }: { tags: string[] | null | undefined }) {
  const { types } = splitTags(tags);
  if (types.length === 0) return null;
  return (
    <>
      {types.map((type) => {
        const meta = TYPE_META[type];
        return (
          <span
            key={type}
            data-testid="team-memory-type-badge"
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

/** 主题标签芯片（中性描边），超出折叠为 +N。 */
export function TopicChips({ tags }: { tags: string[] | null | undefined }) {
  const { topics } = splitTags(tags);
  if (topics.length === 0) return null;
  const shown = topics.slice(0, MAX_TOPIC_TAGS);
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
    <div
      data-testid="team-memory-topic-chips"
      style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}
    >
      {shown.map((tag) => (
        <span key={tag} style={chip}>
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span style={chip} title={topics.slice(MAX_TOPIC_TAGS).join("、")}>
          +{rest}
        </span>
      )}
    </div>
  );
}

/** 自动注入徽标（只读形态：本 tab 不提供编辑，开关在管理页）。 */
export function AutoInjectBadge({ on }: { on: boolean }) {
  return (
    <span
      data-testid="team-memory-inject-badge"
      data-auto-inject={on ? "true" : "false"}
      title={on ? "每轮自动注入给 Agent" : "仅 memory_search 按需检索"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: on ? "rgba(13,148,136,0.08)" : neutral[100],
        border: `1px solid ${on ? "rgba(13,148,136,0.22)" : neutral[200]}`,
        color: on ? INJECT_ON : neutral[500],
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {on ? "注入中" : "仅检索"}
    </span>
  );
}

/**
 * 引用次数徽标：refCount 是记忆重要度排序的核心指标（被检索/注入命中次数）。
 * 0 次 = 尚未被用到，用中性色弱化；≥1 用品牌青强调。
 */
export function RefCountBadge({
  count,
  lastUsedAt,
}: {
  count: number;
  lastUsedAt?: string | null;
}) {
  const safe = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  const hot = safe > 0;
  const lastUsedText = lastUsedAt
    ? `，最近一次 ${formatRelativeTime(lastUsedAt)}`
    : "";
  return (
    <span
      data-testid="team-memory-refcount-badge"
      data-ref-count={safe}
      title={
        hot
          ? `被检索命中 ${safe} 次${lastUsedText}`
          : "尚未被检索命中"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: hot ? "rgba(13,148,136,0.08)" : neutral[100],
        border: `1px solid ${hot ? "rgba(13,148,136,0.22)" : neutral[200]}`,
        color: hot ? INJECT_ON : neutral[400],
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      引用 {safe}
    </span>
  );
}

/** 「已合并至 <id>」只读标记（合并由 Agent 工具执行，本 tab 不提供操作）。 */
export function MergedMarker({ mergedIntoId }: { mergedIntoId: string }) {
  return (
    <span
      data-testid="team-memory-merged-marker"
      title={`该记忆已被合并进 ${mergedIntoId}，不再参与注入与检索`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        color: neutral[500],
        fontSize: fontSize.xs,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      已合并至 {mergedIntoId}
    </span>
  );
}

/** 级别徽标（管理页 LevelBadge 的同口径文本形态）。 */
export function LevelBadge({ level }: { level: MemoryLevel }) {
  return (
    <span
      data-testid="team-memory-level-badge"
      data-level={level}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `1px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: surface,
        border: `1px solid ${neutral[200]}`,
        color: neutral[500],
        fontSize: fontSize.xs,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {levelLabel(level)}
    </span>
  );
}