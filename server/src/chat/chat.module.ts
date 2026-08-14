import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { MessageDispatcher } from './message-dispatcher';
import { WorkerDispatcher } from './worker-dispatcher';

/**
 * 群聊模块（09 篇 §3.5 Chat；10 篇 消息/频道/触发机制）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例，
 *   保证 'm'/'c' 前缀跨模块计数一致，ChatService.onModuleInit 重启续号）；
 * - MessageDispatcher 抽象由 WorkerDispatcher 实现（Phase 4 真实分派：定位/分配 worker →
 *   doclib 上下文注入 → WorkerClient 下发 → 自持轮询/ingress 回流落库 + 广播，18 篇 §8.3）；
 *   WORKER_MOCK_FALLBACK 开关语义仅存于注释（F2 MINOR：本类不实现该开关）。
 * - imports：WorkersModule（WorkersService/WorkerClient/SessionLifecycleService）、
 *   ArtifactsModule（ArtifactsService.onArtifactSubmitted 产出物归档）——均已有 exports。
 * - PermissionGuard（CONF-02 方案②补齐矩阵守卫）：端点叠加 chats.view/create/edit/delete，
 *   频道成员校验在 service 层（channel → taskId → projectId → project_members）。
 * - WorkerDispatcher 以类 token 注册并导出（FR-13：platform-mcp 模块注入调用
 *   dispatchAgentMention），MessageDispatcher 抽象经 useExisting 复用同一实例——
 *   单一 WorkerDispatcher 实例（T9 接线/看门狗仅一份），两个 token 指向它。
 */
@Module({
  imports: [RealtimeModule, WorkersModule, ArtifactsModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    PermissionGuard,
    WorkerDispatcher,
    { provide: MessageDispatcher, useExisting: WorkerDispatcher },
  ],
  exports: [ChatService, WorkerDispatcher],
})
export class ChatModule {}
