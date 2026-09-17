/**
 * 触发器 kind 白名单（trigger-unification todo-2 建表，todo-4 补全六 kind）。
 *
 * - kind 是后端强制的注册表：`TriggerService.schedule` 拒绝白名单外 kind
 *  （未知 kind 必须 expire + 大声报错，禁止静默 feature-detect）。
 * - handler 接线归 todo-4（`registerHandler` 运行期不强制白名单，见
 *   trigger.service.ts；未知 kind 在 fireOne 落 failed 大声暴露）；
 *   消费者迁移归 todo-5/6；`progression_patrol`/`session_idle_scan`/
 *   `hook_fire`/`hook_poll` 由 todo-8/9/11 消费，此处先声明防白名单 churn。
 * - dedup 口径与历史逐字节一致：`receipt_nudge:{teamId}:{receiptId}`、
 *   `review_round_timeout:{issueId}:{round}`（buildTriggerDedupKey 只是组装，
 *   不改变既有 key 形状）。
 */

export const TRIGGER_KIND = {
  RECEIPT_NUDGE: 'receipt_nudge',
  REVIEW_ROUND_TIMEOUT: 'review_round_timeout',
  PROGRESSION_PATROL: 'progression_patrol',
  SESSION_IDLE_SCAN: 'session_idle_scan',
  HOOK_FIRE: 'hook_fire',
  HOOK_POLL: 'hook_poll',
} as const;

export type TriggerKind = (typeof TRIGGER_KIND)[keyof typeof TRIGGER_KIND];

const TRIGGER_KIND_SET: ReadonlySet<string> = new Set<string>(
  Object.values(TRIGGER_KIND),
);

/** kind 是否在白名单内（schedule 入口强制门）。 */
export function isTriggerKind(kind: string): kind is TriggerKind {
  return TRIGGER_KIND_SET.has(kind);
}

/**
 * 组装触发器 dedupKey：`kind:scope:id`（调用方显式传 scope/id，保持历史形状）。
 *
 * 例：`buildTriggerDedupKey(TRIGGER_KIND.RECEIPT_NUDGE, teamId, receiptId)`
 * === 旧 `buildReceiptNudgeDedupKey(teamId, receiptId)`（逐字节一致）。
 */
export function buildTriggerDedupKey(
  kind: string,
  scope: string,
  id: string | number,
): string {
  return `${kind}:${scope}:${id}`;
}

/**
 * 触发器来源（todo-22 REST 列表派生字段 `source` 的唯一映射点）。
 *
 * - `agent`：agent 经 hook 自建的触发器（`hook_fire`/`hook_poll`，
 *   `ownerInstanceId` 归属 agent 实例，由 hook_register 服务端写入）；
 * - `system`：其余白名单 kind（平台基座排期：receipt_nudge /
 *   review_round_timeout / progression_patrol / session_idle_scan）。
 *
 * 规则：禁止在 controller/service 里自建第二份 kind→source 名单，一律走
 * `triggerSourceOf`。白名单外未知 kind 归 `system`（展示侧 fail-closed；
 * schedule 入口仍拒绝未知 kind，见 isTriggerKind）。
 */
export const TRIGGER_SOURCE = {
  AGENT: 'agent',
  SYSTEM: 'system',
} as const;

export type TriggerSource =
  (typeof TRIGGER_SOURCE)[keyof typeof TRIGGER_SOURCE];

/** agent 自建 hook kind（ownerInstanceId 归属 agent，其余白名单 kind 均为系统项）。 */
const AGENT_TRIGGER_KINDS: ReadonlySet<string> = new Set<string>([
  TRIGGER_KIND.HOOK_FIRE,
  TRIGGER_KIND.HOOK_POLL,
]);

/** kind→source 派生（唯一入口，见上）。 */
export function triggerSourceOf(kind: string): TriggerSource {
  return AGENT_TRIGGER_KINDS.has(kind)
    ? TRIGGER_SOURCE.AGENT
    : TRIGGER_SOURCE.SYSTEM;
}

/**
 * kind→中文展示标签（triggers-display：服务端 display.description 回退 +
 * 列表未知 kind 展示，web 侧 KIND_LABEL 与此同值，改一处须同步另一处）。
 * 未知 kind 回退原样（调用方 `?? kind`）。
 */
export const TRIGGER_KIND_LABEL: Record<string, string> = {
  [TRIGGER_KIND.RECEIPT_NUDGE]: '催办',
  [TRIGGER_KIND.REVIEW_ROUND_TIMEOUT]: '评审超时',
  [TRIGGER_KIND.PROGRESSION_PATROL]: '进度巡检',
  [TRIGGER_KIND.SESSION_IDLE_SCAN]: '空闲扫描',
  [TRIGGER_KIND.HOOK_FIRE]: '定时',
  [TRIGGER_KIND.HOOK_POLL]: '条件',
};

/**
 * 触发器 REST API 错误码（todo-22 `GET/DELETE /api/v1/triggers`，
 * 对齐 tool.constants.ts 的 TOOL_ERRORS 命名约定：大写 SNAKE，随异常 code 返回）。
 *
 * - 不存在 id（DELETE）→ 404 TRIGGER_NOT_FOUND
 * - 成员列表缺 teamId（全局列表 admin-scoped，跨团队不可见）→ 403 TRIGGER_TEAM_SCOPE_REQUIRED
 * - 成员取消系统项（系统项只读，团队 Tab 无取消按钮）→ 403 TRIGGER_SYSTEM_READONLY
 * - 成员取消非本团队 agent 项 → 403 TRIGGER_FORBIDDEN
 */
export const TRIGGER_API_ERRORS = {
  TRIGGER_NOT_FOUND: 'TRIGGER_NOT_FOUND',
  TRIGGER_TEAM_SCOPE_REQUIRED: 'TRIGGER_TEAM_SCOPE_REQUIRED',
  TRIGGER_SYSTEM_READONLY: 'TRIGGER_SYSTEM_READONLY',
  TRIGGER_FORBIDDEN: 'TRIGGER_FORBIDDEN',
} as const;

export type TriggerApiErrorCode =
  (typeof TRIGGER_API_ERRORS)[keyof typeof TRIGGER_API_ERRORS];
