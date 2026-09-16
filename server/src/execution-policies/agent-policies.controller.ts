import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * opencode agent 定义 + guard 角色集（vteam-role-behavior-enforcement Todo 12）。
 * worker injector（Todo 15）的数据源：拉取后写入 `opencode.json` agent 节与
 * `.vteam-role-guard/roles.json`。
 *
 * 鉴权复用 worker 面向资源端点的 `WorkerOrJwtGuard`（与 mcp-servers/tools/skills
 * GET 同模式）：`@Public()` 跳过全局 JWT 守卫，带 `X-Worker-Token` 走 worker
 * 通道，否则走用户 JWT；均无 → 401。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/agent-policies。
 */
@ApiTags('agent-policies')
@ApiBearerAuth()
@Controller('agent-policies')
export class AgentPoliciesController {
  constructor(private readonly policies: ExecutionPolicyService) {}

  @Public()
  @UseGuards(WorkerOrJwtGuard)
  @Get()
  @ApiOperation({
    summary: 'opencode agent 定义 + guard 角色集（worker 拉取）',
  })
  async getAgentPolicies() {
    return this.policies.buildAgentPolicies();
  }
}
