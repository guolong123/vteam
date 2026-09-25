import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { NotificationChannelsModule } from '../notifications/notification-channels.module';
import { ChatModule } from '../chat/chat.module';
import { GitReposModule } from '../git-repos/git-repos.module';
import { IssuesModule } from '../issues/issues.module';
import { QuestionsModule } from '../questions/questions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TasksModule } from '../tasks/tasks.module';
import { TimersModule } from '../timers/timers.module';
import { WorkersModule } from '../workers/workers.module';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { PlatformMcpController } from './platform-mcp.controller';
import { PlatformMcpService } from './platform-mcp.service';
import { PlatformToolPermissionService } from './platform-tool-permission.service';
import { ReviewRoundTimeoutHandler } from '../chat/review-round-timeout.handler';
import { SkillsModule } from '../skills/skills.module';

/**
 * 平台 MCP 模块（阶段 1：server 平台 MCP 端点，SDK + StreamableHTTP）。
 *
 * - `POST /api/v1/platform-mcp`（PlatformMcpController）：`@Public()` + WorkerTokenGuard，
 *   暴露 13 个 MCP 工具（chat_history/doclib/task_context/group_post/read_file/notify_agent/
 *   submit_artifact + issue_create/issue_list/issue_get/issue_update/issue_transition +
 *   task_transition）。
 * - PrismaService 由全局 PrismaModule 提供；
 *   RealtimeService + IdGeneratorService 由 RealtimeModule 导出（'m' 前缀与 chat 域同源）。
 * - WorkersModule 导出 WorkerClient（FR-41：group_post fileRef 未命中归档时经其从
 *   worker 工作区拉取文件内容）；WorkersModule 内部与 McpServersModule/ModelsModule
 *   的 forwardRef 环已自解，本模块单向依赖无新环。
 * - WorkerTokenGuard 在 WorkersModule 中未导出，本模块自行注册（依赖 ConfigService，
 *   全局 ConfigModule 提供），不改动 WorkersModule。
 * - ChatModule 导出 WorkerDispatcher（FR-13：notify_agent 工具经其触发目标 agent
 *   dispatch）；ChatModule imports Realtime/Workers/Artifacts，不反向依赖本模块，无环。
 * - ArtifactsModule 导出 ArtifactsService（submit_artifact text 类型直接落库归档）；
 *   ArtifactsModule 仅依赖 RealtimeModule，无环。
 * - IssuesModule 导出 IssuesService（issue_* 工具经其做 agent 团队校验与 issue CRUD/状态机）；
 *   IssuesModule 仅依赖 RealtimeModule，无环。
 * - TasksModule 导出 TasksService（task_transition 工具经其做主实例校验与五态状态机流转）
 *   与 PlanStepsService（vteam_todo 工具经其读写 plan_tasks 执行步骤）；
 *   TasksModule imports RealtimeModule/WorkersModule，不反向依赖本模块，无环。
 * - QuestionsModule 导出 QuestionsService（question_confirm 工具经其做主实例校验与
 *   question/permission 确认转发）；QuestionsModule imports RealtimeModule/WorkersModule，
 *   不反向依赖本模块，无环。
 * - ReviewRoundTimeoutHandler（review-round-open 超时消费者，文件落 chat 域、
 *   provider 注册在本模块）：本模块已 import IssuesModule（gate+rounds 导出）与
 *   TimersModule，无新增模块边（ChatModule 注册则需新增 IssuesModule 依赖）。
 * - PlatformToolPermissionService（工具权限门）：只依赖 PrismaService（全局 PrismaModule），
 *   按 `AgentRole.capabilities`（岗位业务能力点矩阵）判定，不再依赖 ExecutionPolicyService
 *   （2026-09-21 capability model 解耦）；controller 在 handler 之前调用，
 *   `tools/list` 不过滤（调用时拦截）。
 */
@Module({
  imports: [
    RealtimeModule,
    WorkersModule,
    ChatModule,
    ArtifactsModule,
    GitReposModule,
    IssuesModule,
    TasksModule,
    QuestionsModule,
    NotificationChannelsModule,
    TimersModule,
    // F2-M4：SkillsService 改由 SkillsModule 导出（单实例复用）；
    // SkillsModule 仅依赖 RealtimeModule/WorkersModule（均不反向依赖本模块），无环。
    SkillsModule,
  ],
  controllers: [PlatformMcpController],
  providers: [
    PlatformMcpService,
    PlatformToolPermissionService,
    WorkerTokenGuard,
    ReviewRoundTimeoutHandler,
  ],
})
export class PlatformMcpModule {}
