import { forwardRef, Module } from '@nestjs/common';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ModelsModule } from '../models/models.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WorkerClient } from './worker.client';
import { WorkerEventIngress } from './worker-event.ingress';
import { WorkerEventsController } from './worker-events.controller';
import { WorkerTokenGuard } from './worker-token.guard';
import { WorkersController } from './workers.controller';
import { WorkersService } from './workers.service';

/**
 * Worker 控制面模块（T7：注册/心跳/调度/健康检查，T1 占位补全）。
 * - Providers：WorkersService（WorkerRegistry + Heartbeat + Scheduler + LifecycleManager 骨架）、
 *   WorkerTokenGuard（X-Worker-Token 鉴权，与用户 JWT 隔离）、
 *   WorkerClient（T8 server→worker HTTP 客户端）、
 *   SessionLifecycleService（T12：Session.workerId/instanceRef 写入 + TaskGroupInstance 落库）
 * - Exports：WorkersService——T10 WorkerDispatcher / T12 Session.workerId 写入复用；
 *   WorkerClient——T10 WorkerDispatcher 下发 prompt 复用；
 *   SessionLifecycleService——T10 bindSessionToWorker / tasks.service 查询委托
 * - Imports：RealtimeModule（IdGeneratorService，ti_ 前缀续号与 t/s/m 同源）；
 *   forwardRef(McpServersModule)——McpServersService 亦反向依赖 WorkersService（F1 MAJOR
 *   资源变更广播），双向模块依赖用 forwardRef 解环；
 *   ModelsModule（C3：worker 注册上报 capabilities.models 合并入库，
 *   ModelsService 不反向依赖 WorkersService，单向 import 无需 forwardRef）
 * - Controller：POST /workers/register、POST /workers/:id/heartbeat、GET /workers、GET /workers/:id；
 *   POST /worker/events（T9 事件回流，WorkerEventsController + WorkerEventIngress）
 * 已在 app.module.ts 注册。
 */
@Module({
  imports: [
    RealtimeModule,
    forwardRef(() => McpServersModule),
    // C3：worker 上报模型合并入库需 ModelsService；C5：注册回放需 CredentialCryptoService。
    // ModelsService 亦依赖 WorkersService 触发下发，双向循环用 forwardRef 解环。
    forwardRef(() => ModelsModule),
  ],
  controllers: [WorkersController, WorkerEventsController],
  providers: [
    WorkersService,
    WorkerTokenGuard,
    WorkerClient,
    SessionLifecycleService,
    WorkerEventIngress,
  ],
  exports: [
    WorkersService,
    WorkerClient,
    SessionLifecycleService,
    WorkerEventIngress,
  ],
})
export class WorkersModule {}
