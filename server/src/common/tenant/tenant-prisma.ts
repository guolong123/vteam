/**
 * 租户 Prisma 注入（**纯函数**，便于单测；由 `PrismaService` 的 `$use` 中间件调用）。
 *
 * 规则（详见设计文档 §4.2 第 2 层防线）：
 * - 读（findMany/findFirst/count/aggregate/groupBy）：
 *   · platform 模型 → `workspaceId IN (当前空间, ws_system)`（平台资源所有空间可见）
 *   · private  模型 → `workspaceId = 当前空间`（严格隔离，不回落系统空间）
 * - 写（create/createMany/update/updateMany/upsert/delete/deleteMany）：
 *   · create 强制写入当前空间（忽略调用方传入的 workspaceId，防伪造）
 *   · update/delete 在 where 上叠加 `workspaceId = 当前空间`（防按主键跨空间改删）
 *   · 跨空间只读态（readOnly）写操作直接拒绝
 * - `system` 模式：显式关闭注入（内部流程）；`seed` 模式：平台资源写系统空间、其余写默认空间。
 *
 * ⚠️ **不注入的操作（TypeScript 复合唯一键限制）**：`findUnique` / `findUniqueOrThrow` /
 *    `update` / `delete` —— 它们的 `where` 是唯一键输入，追加 `workspaceId` 会被 Prisma 类型拒绝。
 *    这些操作必须由服务层用 `tenantUniqueWhere(model, fields)` 构造复合唯一键（或改用
 *    `updateMany`/`deleteMany`，后者会被本中间件注入空间条件）。
 * ⚠️ 覆盖不到的路径：`$queryRawUnsafe` / `$executeRaw` / `findRaw` / `aggregateRaw`
 *    以及未经 Prisma 的文件/SSE/MCP 通道——必须由服务层显式校验（见设计文档第 3 层防线）。
 */
import { ForbiddenException } from '@nestjs/common';
import { TENANT_ERRORS, TENANT_WORKSPACE_ID } from './tenant.constants';
import type { TenantContext } from './tenant-context';
import { tenantScopeOf } from './tenant-models';

/** Prisma `$use` 回调参数的最小子集（避免依赖 Prisma 内部类型）。 */
export interface TenantQueryParams {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === 'object'
    ? (value as AnyRecord)
    : {};
}

/** 读过滤条件：platform 回落系统空间，private 严格当前空间。 */
function readFilter(
  scope: 'platform' | 'private',
  ctx: TenantContext,
): AnyRecord {
  return scope === 'platform'
    ? { workspaceId: { in: [ctx.workspaceId, TENANT_WORKSPACE_ID.SYSTEM] } }
    : { workspaceId: ctx.workspaceId };
}

/** 写目标空间：seed 模式下平台资源写系统空间；其余写上下文空间。 */
function writeTargetWorkspace(
  scope: 'platform' | 'private',
  ctx: TenantContext,
): string {
  if (ctx.mode === 'seed' && scope === 'platform') {
    return TENANT_WORKSPACE_ID.SYSTEM;
  }
  return ctx.workspaceId;
}

function assertWritable(ctx: TenantContext): void {
  if (ctx.mode === 'system' || ctx.mode === 'seed') {
    return;
  }
  if (ctx.readOnly) {
    throw new ForbiddenException({
      code: TENANT_ERRORS.CROSS_WORKSPACE_WRITE_FORBIDDEN,
      message: '跨空间只读态下不允许写操作',
    });
  }
  if (ctx.workspaceId === TENANT_WORKSPACE_ID.SYSTEM && !ctx.isPlatformAdmin) {
    throw new ForbiddenException({
      code: TENANT_ERRORS.SYSTEM_WORKSPACE_WRITE_FORBIDDEN,
      message: '系统空间为平台只读资源，普通用户不可写入',
    });
  }
}

/** 给 where 叠加空间条件（顶层字段，Prisma 语义为 AND，兼容既有 OR/AND）。 */
function scopeWhere(
  where: unknown,
  scope: 'platform' | 'private',
  ctx: TenantContext,
): AnyRecord {
  return { ...asRecord(where), ...readFilter(scope, ctx) };
}

/**
 * `findUnique` / `findUniqueOrThrow` 结果兜底：这类查询无法在 where 追加空间条件，
 * 返回后按行上的 `workspaceId` 再校验一次，越权行一律按「不存在」处理（返回 null）。
 *
 * - 用户态模型：只允许当前空间；
 * - 平台模型：允许当前空间或系统空间；
 * - system/seed 模式或无上下文：不校验（内部流程）。
 */
export function guardUniqueReadResult(
  model: string | undefined,
  operation: string,
  result: unknown,
  ctx: TenantContext | undefined,
): unknown {
  if (!ctx || ctx.mode !== 'request') return result;
  if (operation !== 'findUnique' && operation !== 'findUniqueOrThrow') {
    return result;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const row = result as Record<string, unknown>;
  const rowWorkspaceId = row.workspaceId;
  if (typeof rowWorkspaceId !== 'string') return result;
  const scope = tenantScopeOf(model);
  const allowed =
    scope === 'platform'
      ? [ctx.workspaceId, TENANT_WORKSPACE_ID.SYSTEM]
      : [ctx.workspaceId];
  return allowed.includes(rowWorkspaceId) ? result : null;
}

/**
 * 主入口：按上下文改写 Prisma 参数。无上下文 / 未登记模型 / system 模式 原样返回。
 */
export function applyTenantScope<T extends TenantQueryParams>(
  params: T,
  ctx: TenantContext | undefined,
): T {
  if (!ctx || ctx.mode === 'system') {
    return params;
  }
  const scope = tenantScopeOf(params.model);
  if (scope === 'none') {
    return params;
  }
  const args = { ...(params.args ?? {}) };
  const isWrite = [
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
  ].includes(params.operation);

  if (!isWrite) {
    // seed 模式读全量（回填脚本需要），request 模式按策略过滤
    // findUnique/findUniqueOrThrow 不注入（唯一键 where 不允许追加非唯一字段），
    // 由 `guardUniqueReadResult` 在查询返回后按行的 workspaceId 兜底校验。
    const injectableRead = [
      'findMany',
      'findFirst',
      'findFirstOrThrow',
      'count',
      'aggregate',
      'groupBy',
    ].includes(params.operation);
    if (ctx.mode === 'request' && injectableRead) {
      args.where = scopeWhere(args.where, scope, ctx);
    }
    return { ...params, args } as T;
  }

  assertWritable(ctx);
  const target = writeTargetWorkspace(scope, ctx);

  switch (params.operation) {
    case 'create':
      args.data = { ...asRecord(args.data), workspaceId: target };
      break;
    case 'createMany':
    case 'createManyAndReturn': {
      const rows = Array.isArray(args.data) ? args.data : [];
      args.data = rows.map((row) => ({
        ...asRecord(row),
        workspaceId: target,
      }));
      break;
    }
    case 'updateMany':
    case 'deleteMany':
      args.where = { ...asRecord(args.where), workspaceId: target };
      break;
    case 'update':
    case 'delete':
      // 唯一键 where 不能追加 workspaceId（Prisma 类型限制）：
      // 调用方必须用 tenantUniqueWhere() 构造复合唯一键，本层放行。
      break;
    case 'upsert':
      args.where = { ...asRecord(args.where), workspaceId: target };
      args.create = { ...asRecord(args.create), workspaceId: target };
      break;
    default:
      // 未知写操作（如 runCommand）：不注入，交由服务层显式校验
      return params;
  }
  return { ...params, args } as T;
}
