/**
 * 成员角色标签解析（agent-role-decommission todo 5）。
 *
 * 角色标签的唯一来源是 `TeamMember.roleId → AgentRole`。本模块把两种**语义不同**的取值
 * 分开命名，避免调用方再混淆（旧 `Agent.role` 列同时承担了这两件事）：
 *
 * - {@link roleKeyOf} —— **机器键**（`AgentRole.key`）：API `role` 字段的值。web 侧用它做
 *   `ROLE_KEYS.includes(...)` / `toAvatarRole(...)` / 颜色查表，必须是 key（如 `developer`），
 *   不能是展示名（`开发者`），否则 `toAvatarRole` 会掉进兜底分支、头像配色改变。
 * - {@link roleLabelOf} —— **人类可读标签**（`AgentRole.name`）：成员默认别名 `<标签>-<seq>`
 *   与触发器 owner 展示用。
 *
 * 未绑角色（`TeamMember.roleId` 为 NULL）或关联行缺失 → 两者均为 null，由调用方按既有
 * 规则回退（`agent.name`）——**绝不产出空串标签**（FR-08 别名默认规则）。
 */
export interface MemberRoleBinding {
  role?: { key: string; name: string } | null;
}

/** 成员角色机器键（`AgentRole.key`）；未绑/行缺失 → null。 */
export function roleKeyOf(
  member: MemberRoleBinding | null | undefined,
): string | null {
  return member?.role?.key ?? null;
}

/** 成员角色展示标签（`AgentRole.name`）；未绑/行缺失 → `fallback`（调用方传 `agent.name`）。 */
export function roleLabelOf(
  member: MemberRoleBinding | null | undefined,
  fallback: string,
): string {
  return member?.role?.name ?? fallback;
}
