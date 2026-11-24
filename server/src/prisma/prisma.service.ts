import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getTenantContext } from '../common/tenant/tenant-context';
import {
  applyTenantScope,
  guardUniqueReadResult,
} from '../common/tenant/tenant-prisma';

/**
 * Prisma 数据访问服务——全局唯一 PrismaClient 实例。
 * 测试环境经 test/setup-env.js 注入 sqlite 测试库（DATABASE_URL=file:./test.db），
 * 保证单测/e2e 不依赖 MySQL。
 *
 * 多工作空间隔离（M1）：用 Prisma client extension（`$extends` 的 `$allOperations`）
 * 挂租户注入：从 AsyncLocalStorage 取当前上下文，对带 workspaceId 的模型自动注入
 * 读过滤与写归属。`$use` 在 Prisma 6.19 已移除，故不采用。
 *
 * ⚠️ `findUnique` / `update` / `delete` 不注入（唯一键 where 无法追加非唯一字段），
 *    调用方须用 `tenantUniqueWhere()` 构造复合唯一键；其余覆盖不到的路径
 *    （raw SQL / 文件 / SSE / MCP）由服务层显式校验。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    const scoped = this.$extends({
      name: 'tenant-scope',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scopedArgs = applyTenantScope(
              {
                model,
                operation,
                args: (args ?? {}) as Record<string, unknown>,
              },
              getTenantContext(),
            ).args;
            const result = await query(scopedArgs as never);
            // 唯一键读（findUnique/findUniqueOrThrow）无法在 where 注入空间条件，
            // 返回后按行 workspaceId 兜底：越权行按「不存在」处理。
            return guardUniqueReadResult(
              model,
              operation,
              result,
              getTenantContext(),
            ) as never;
          },
        },
      },
    });

    // 扩展返回新的 client 代理：以它为实际实例（onModuleInit/Destroy 由 Nest 调用）。
    const service = scoped as unknown as PrismaService;
    service.onModuleInit = async () => {
      await (scoped as unknown as PrismaClient).$connect();
    };
    service.onModuleDestroy = async () => {
      await (scoped as unknown as PrismaClient).$disconnect();
    };
    return service;
  }

  // 仅用于满足类型/接口；运行时被构造器返回的扩展 client 覆盖。
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
