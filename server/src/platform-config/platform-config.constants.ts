/**
 * 平台配置键定义（会话上下文压缩）。
 *
 * 每个键 = { 键名, 值类型, 默认值, 说明 }。服务层以本表为**白名单与校验依据**：
 * - 未知键 → 拒绝落库（不允许新增任意键，避免配置表变成杂货铺）；
 * - 值按 valueType 解析，越界/非法 → 400 拒绝；
 * - 界面展示的说明与默认值也来自本表，保证前后端单源。
 *
 * 新增一个配置项 = 在下方加一行（并在 seed 里补默认值落库，见 service 的 ensureDefaults）。
 */

/** 平台配置值类型（存库统一为字符串，服务层按类型解析）。 */
export type PlatformConfigValueType = 'number' | 'bool' | 'string';

/** 单个配置键的元信息。 */
export interface PlatformConfigSpec {
  /** 配置键（大写下划线，落库 `key` 列）。 */
  key: string;
  /** 值类型。 */
  valueType: PlatformConfigValueType;
  /** 默认值（服务层校验/回落口径）。 */
  defaultValue: string;
  /** 人可读说明（界面展示）。 */
  description: string;
}

/**
 * 会话上下文压缩（idle 压缩）的四个可调参数。
 *
 * 语义详见 docs/agent-platform/context-compaction-idle.md §8：
 * - 条件① 不活跃天数：`0` = 关闭整个特性；
 * - 条件② 上下文下限：低于该值不压（小会话不值得）；
 * - `AWAIT_MS`：等压缩落完的上限，超时放弃压缩、照常投递消息（fail-open）；
 * - `TIMEOUT_MS`：压缩本身的超时预算。
 */
export const SESSION_COMPACT_CONFIG_SPECS: readonly PlatformConfigSpec[] = [
  {
    key: 'SESSION_COMPACT_IDLE_DAYS',
    valueType: 'number',
    defaultValue: '3',
    description: '会话超过该天数不活跃，下一次发消息前触发上下文压缩；填 0 关闭该特性',
  },
  {
    key: 'SESSION_COMPACT_MIN_CONTEXT_TOKENS',
    valueType: 'number',
    defaultValue: '40000',
    description: '触发压缩的上下文下限（token）；低于该值的会话不压缩',
  },
  {
    key: 'SESSION_COMPACT_AWAIT_MS',
    valueType: 'number',
    defaultValue: '120000',
    description: '等待压缩完成的上限（毫秒）；超时则放弃压缩、照常投递消息',
  },
  {
    key: 'SESSION_COMPACT_TIMEOUT_MS',
    valueType: 'number',
    defaultValue: '180000',
    description: '压缩本身的超时预算（毫秒）',
  },
] as const;

/** 配置键名集合（服务层白名单）。 */
export const PLATFORM_CONFIG_KEYS: ReadonlySet<string> = new Set(
  SESSION_COMPACT_CONFIG_SPECS.map((s) => s.key),
);

/** 按键取规格；未知键返回 undefined。 */
export function findPlatformConfigSpec(
  key: string,
): PlatformConfigSpec | undefined {
  return SESSION_COMPACT_CONFIG_SPECS.find((s) => s.key === key);
}
