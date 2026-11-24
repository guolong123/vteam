/**
 * 租户请求上下文（AsyncLocalStorage）。
 *
 * 由 `WorkspaceGuard` 解析出当前空间后写入 `req.tenant`，
 * `TenantContextInterceptor` 在请求处理期间用 `runWithTenant` 包裹，
 * Prisma 中间件（`PrismaService`）从该上下文取「当前空间」自动注入过滤/归属。
 *
 * 三种模式：
 * - `request`：普通请求（按模型策略注入读过滤与写归属）。
 * - `system`：内部系统流程（worker 注册、事件回流、定时任务、seed 回填等）——**显式**关闭注入。
 *   只允许在明确知道自己在做什么的入口使用，禁止从 HTTP 请求参数透传。
 * - `seed`：seed / 一次性脚本（写入平台资源到系统空间、普通数据到默认空间）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { TENANT_WORKSPACE_ID } from './tenant.constants';

export type TenantMode = 'request' | 'system' | 'seed';

export interface TenantContext {
  /** 当前空间 id（request/seed 必填；system 模式可为空 = 不注入）。 */
  workspaceId: string;
  /** 当前登录用户（内部流程可为空）。 */
  userId?: string;
  mode: TenantMode;
  /**
   * 跨空间只读：平台管理员查看其它空间时为 true。
   * 写入一律拒绝（`TENANT_CROSS_WORKSPACE_WRITE_FORBIDDEN`）。
   */
  readOnly?: boolean;
  /** 是否为平台管理员（用于跨空间读、系统空间维护的判定）。 */
  isPlatformAdmin?: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** 在指定租户上下文中执行（同步/异步均可）。 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 读取当前租户上下文；不在请求链路内（如模块初始化）返回 undefined。 */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** 系统模式上下文（内部流程显式使用，关闭自动注入）。 */
export function systemTenantContext(userId?: string): TenantContext {
  return { workspaceId: TENANT_WORKSPACE_ID.SYSTEM, mode: 'system', userId };
}

/** seed 模式上下文（脚本/回填使用）。 */
export function seedTenantContext(): TenantContext {
  return { workspaceId: TENANT_WORKSPACE_ID.DEFAULT, mode: 'seed' };
}
