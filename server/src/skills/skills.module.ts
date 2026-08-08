import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { WorkersModule } from '../workers/workers.module';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/**
 * Skill 模块（T1 重构对齐 09 篇 §3.8：multipart 上传 + status 端点 + AdminGuard）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/chat/artifacts/agents 同源，skill 域前缀 sk_）。
 * AdminGuard 复用 users/admin.guard.ts（无状态：仅依赖全局 PrismaService），
 * 本模块单独注册为 provider 供 POST/PATCH 管理端点守卫使用；
 * WorkerOrJwtGuard 供 GET 读取端点双通道鉴权（worker X-Worker-Token / 用户 JWT，T4b）。
 * WorkersModule：F1 MAJOR——技能变更（POST/PATCH）后经 WorkersService 广播 reload-config。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [SkillsController],
  providers: [SkillsService, AdminGuard, WorkerOrJwtGuard],
})
export class SkillsModule {}
