/**
 * seed / 一次性脚本专用的复合唯一键构造器（**自包含，不 import src**）。
 *
 * 原因：生产 runner 镜像只含 dist/node_modules/prisma（无 src/），prisma/seed.ts 的
 * 既有约定是不 import ../src。本文件与 `src/common/tenant/tenant-unique.ts` 保持同构，
 * 仅把「取当前上下文」替换为「显式传空间 id」。
 *
 * 用法：`where: seedUniqueWhere({ key: role.key }, SEED_WORKSPACE.SYSTEM)`
 * 字段顺序必须与 schema 复合唯一键定义顺序一致（值在对象里按插入顺序拼键名）。
 */

/** 固定引导空间 id（与 src/common/tenant/tenant.constants.ts 一致）。 */
export const SEED_WORKSPACE = {
  SYSTEM: 'ws_system',
  DEFAULT: 'ws_default',
} as const;

export type SeedWorkspaceId =
  (typeof SEED_WORKSPACE)[keyof typeof SEED_WORKSPACE];

/** 构造带 workspaceId 的复合唯一键 where（脚本用）。 */
export function seedUniqueWhere(
  fields: Record<string, unknown>,
  workspaceId: SeedWorkspaceId,
): any {
  const key = ['workspaceId', ...Object.keys(fields)].join('_');
  return { [key]: { workspaceId, ...fields } };
}
