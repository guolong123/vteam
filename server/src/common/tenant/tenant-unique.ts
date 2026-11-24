/**
 * 复合唯一键 where 构造器（配合 `workspaceId` 前缀的唯一键改造）。
 *
 * 背景：唯一键改为 `(workspaceId, <原唯一字段...>)` 后，`findUnique` / `update` /
 * `delete` / `upsert` 的 `where` 必须使用复合唯一键输入，不能再用原来的单字段输入。
 * 而复合唯一键的 workspaceId 只能取**确切值**（不能用 `in`），所以这里按上下文取：
 * - 请求链路：当前空间；
 * - 无上下文（模块初始化 / 一次性脚本）：平台模型回落 `ws_system`，其余回落 `ws_default`
 *   （与迁移/seed 的归属一致）。
 *
 * 用法：
 * ```ts
 * await prisma.team.findUnique({ where: tenantUniqueWhere('Team', { name }) });
 * await prisma.trigger.findUnique({ where: tenantUniqueWhere('Trigger', { dedupKey }) });
 * ```
 *
 * ⚠️ 返回类型为宽松对象：Prisma 的复合唯一键输入名由字段顺序拼成
 *    （`workspaceId_providerID_modelID`），TS 无法从运行期拼出的 key 推导，故这里断言。
 *    字段顺序必须与 schema 中复合唯一键的定义顺序一致。
 */
import { TENANT_WORKSPACE_ID } from './tenant.constants';
import { getTenantContext } from './tenant-context';
import { tenantScopeOf } from './tenant-models';

/** 这些平台模型的写入默认落默认空间（worker 上报 / 用户自建场景），其余平台模型落系统空间。 */
const PLATFORM_DEFAULT_WRITE_FALLBACK = new Set(['Model', 'McpServer']);

/**
 * 构造带 workspaceId 的复合唯一键 where。
 *
 * @param model PRISMA 模型名（如 'Team'）
 * @param fields 原唯一字段（顺序与 schema 复合唯一键一致）
 * @param explicitWorkspaceId 显式空间（seed/运维脚本用）；缺省按上下文/回落规则
 */
export function tenantUniqueWhere(
  model: string,
  fields: Record<string, unknown>,
  explicitWorkspaceId?: string,
): any {
  const ctx = getTenantContext();
  const scope = tenantScopeOf(model);
  const workspaceId =
    explicitWorkspaceId ??
    ctx?.workspaceId ??
    (scope === 'platform' && !PLATFORM_DEFAULT_WRITE_FALLBACK.has(model)
      ? TENANT_WORKSPACE_ID.SYSTEM
      : TENANT_WORKSPACE_ID.DEFAULT);
  const key = ['workspaceId', ...Object.keys(fields)].join('_');
  return { [key]: { workspaceId, ...fields } };
}
