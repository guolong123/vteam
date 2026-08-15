import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Swagger-MCP 域错误码（随 HttpException 响应的 code 字段返回；控制器
 * toErrorMessage 取 message 保证 agent 可读）。
 */
export const SWAGGER_MCP_ERRORS = {
  /** 权限拒绝（未授权/无实例上下文/ask 降级）。 */
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type SwaggerMcpErrorCode =
  (typeof SWAGGER_MCP_ERRORS)[keyof typeof SWAGGER_MCP_ERRORS];

/** 权限校验通过后的调用方上下文（controller 透传给 handler 前的归属校验依据）。 */
export interface SwaggerMcpAuthContext {
  workerId: string;
  /** 模板 Agent id（AgentToolEffect 权限点主体）。 */
  agentId: string;
  /** 任务实例 id（taskAgentId，worker 当前执行实例）。 */
  taskAgentId: string;
}

/**
 * 权限点校验（阶段 2 任务 12）。
 *
 * 每个 Swagger 工具 = 一个 toolAction 权限点。tools/call 时解析调用实例 →
 * 所属 Agent → 读 `AgentToolEffect[agentId+toolName]`：
 * - effect=allow → 放行；
 * - effect=deny / 未配置 → 拒绝（默认 deny 兜底管理面 API）；
 * - effect=ask → v1 降级为 deny（ask 确认流未实现）。
 *
 * 解析失败（worker 无活跃会话 / 实例缺失）→ 拒绝——无 agent 上下文时禁止匿名
 * 调用。归属校验（assertWorkerTask）：workerId + taskId → 该 worker 有绑定会话，
 * 防跨任务访问（对齐 platform-mcp 的语义）。
 */
@Injectable()
export class SwaggerMcpAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 工具级权限校验。返回 {agentId, taskAgentId} 供 controller 归属校验/透传；
   * 未授权一律抛 ForbiddenException（code=FORBIDDEN）。
   */
  async authorize(
    workerId: string,
    toolName: string,
  ): Promise<SwaggerMcpAuthContext> {
    if (!workerId) {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: '缺少 x-worker-id header',
      });
    }

    const session = await this.prisma.session.findFirst({
      where: { workerId, status: 'running' },
      select: { taskAgentId: true },
    });
    if (!session) {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: '无法解析调用实例上下文',
      });
    }

    const ta = await this.prisma.taskAgent.findUnique({
      where: { id: session.taskAgentId },
      select: { agentId: true },
    });
    if (!ta) {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: '无法解析调用实例上下文',
      });
    }

    const effect = await this.prisma.agentToolEffect.findUnique({
      where: {
        agentId_toolAction: { agentId: ta.agentId, toolAction: toolName },
      },
    });
    const eff = effect?.effect;
    if (eff === 'allow') {
      return {
        workerId,
        agentId: ta.agentId,
        taskAgentId: session.taskAgentId,
      };
    }
    if (eff === 'ask') {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: 'ask 确认流 v1 未支持，请配置为 allow',
      });
    }
    // effect=deny / 未配置 → 默认 deny（安全默认）
    throw new ForbiddenException({
      code: SWAGGER_MCP_ERRORS.FORBIDDEN,
      message: '工具未授权，请在 Agent 配置中开启',
    });
  }

  /**
   * taskId 归属校验：该 worker 有绑定该任务的 Session 才放行。
   * 无绑定 → 拒绝（防跨任务访问，安全不降级）。
   */
  async assertWorkerTask(workerId: string, taskId: string): Promise<void> {
    if (!workerId) {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: '缺少 x-worker-id header',
      });
    }
    const session = await this.prisma.session.findFirst({
      where: { taskId, workerId },
      select: { id: true },
    });
    if (!session) {
      throw new ForbiddenException({
        code: SWAGGER_MCP_ERRORS.FORBIDDEN,
        message: '该 worker 无此任务会话，禁止跨任务访问',
      });
    }
  }
}
