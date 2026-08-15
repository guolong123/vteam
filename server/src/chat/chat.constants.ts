/**
 * 群聊域错误码常量（对齐 09 篇 §3.5 Chat、10 篇 §4 触发机制）。
 *
 * 错误码命名沿用现有约定（大写 SNAKE，随异常响应的 code 字段返回）：
 * - 频道/资源不存在 → 404
 * - 归档任务频道发消息 → 409（MUST DO：TASK_ARCHIVED）
 * - @ 解析非法（agent 不在团队 / type 非法 / 缺 agentId）→ 400
 */
export const CHAT_ERRORS = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  TASK_ARCHIVED: 'TASK_ARCHIVED',
  MENTION_AGENT_NOT_IN_TEAM: 'MENTION_AGENT_NOT_IN_TEAM',
  MENTION_TYPE_INVALID: 'MENTION_TYPE_INVALID',
  CHANNEL_TYPE_INVALID: 'CHANNEL_TYPE_INVALID',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_NOT_USER: 'MESSAGE_NOT_USER',
  SESSION_HISTORY_NOT_SUPPORTED: 'SESSION_HISTORY_NOT_SUPPORTED',
} as const;

export type ChatErrorCode = (typeof CHAT_ERRORS)[keyof typeof CHAT_ERRORS];

/**
 * 群聊 @Agent 收到确认默认文案：agent.ackMessage 未配置时的兜底（agent 配置页可覆盖）。
 * seed.ts 模板 Agent 预置同值（create 分支），保证开箱即有确认提示。
 */
export const DEFAULT_ACK_MESSAGE = '收到，正在处理…';
