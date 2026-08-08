import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 数据访问服务——全局唯一 PrismaClient 实例。
 * 测试环境经 test/setup-env.js 注入 sqlite 测试库（DATABASE_URL=file:./test.db），
 * 保证单测/e2e 不依赖 MySQL。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
