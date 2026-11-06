/**
 * 会话作用域开关（37 篇 D4 / P3）。
 *
 * - `seat`（默认）：一席位一会话（sessions.team_member_key），现网行为；
 * - `member`：一成员一全局会话（sessions.member_key），跨群共享记忆。
 *
 * 灰度口径：环境变量 `SESSION_SCOPE` 精确等于 `member` 才启用；其他值/未设置
 * 一律回落 `seat`，保证升级后行为不变、可随时回滚。
 */
export type SessionScope = 'member' | 'seat';

export function getSessionScope(): SessionScope {
  return (process.env.SESSION_SCOPE ?? '').trim().toLowerCase() === 'member'
    ? 'member'
    : 'seat';
}

export function isMemberSessionScope(): boolean {
  return getSessionScope() === 'member';
}
