import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';

/**
 * 平台工具权限门（opencode-native-permissions-and-fixes todo 3）。
 *
 * `tools/call` 的**能力**判定（与归属判定分离）：调用方成员 → 绑定 Agent →
 * `ExecutionPolicyService.resolveByAgent`（DB `config.tools` 胜出，行缺失时内置名
 * 回退 `ROLE_BOUNDARIES[*].toolAllows` 常量）→ 该 Agent 的 `tools` 矩阵 →
 * `vteam_<receivedBareName>` 命中 `allow`/`ask` 才放行，否则 403。
 *
 * 命名契约（todo 1 实证，`CONTRACT-tool-naming-and-identity.md` §1）：服务端收到的是
 * **裸名**（`doclib`），矩阵键是 `vteam_<action>`；本服务是这条桥接的**唯一**位置
 * （`vteam_${bareToolName}`），调用方不得自带前缀、不得再剥前缀。
 *
 * **fail-closed**（契约 §4，有意与 `worker/src/role-guard/policy.ts` 的 pass-through
 * 分道）：成员/Agent/策略/矩阵任一环节解析不出，或解析抛错，一律 403 ——
 * todos 4/5 移除 worker guard 与 `vteam_*` 权限载荷后，本检查是平台工具的唯一闸门，
 * pass-through 会让它们彻底失守。todos 4/5 之后 `tools/list` 仍对每个 Agent 全量
 * （调用时拦截，不在清单处过滤）。
 *
 * 测试性：本服务只依赖「成员 id + 工具裸名」，与身份解析（`PlatformMcpService`）解耦，
 * 可用真实 `ExecutionPolicyService` + 内存 policy 行做可证伪的矩阵判定测试
 * （`platform-mcp.tool-permission.spec.ts`）。
 */
@Injectable()
export class PlatformToolPermissionService {
  private readonly logger = new Logger(PlatformToolPermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionPolicyService: ExecutionPolicyService,
  ) {}

  /**
   * 断言调用方（团队成员/实例 id）的绑定策略允许调用 `bareToolName`。
   * 通过 → resolve；不通过 → `ForbiddenException` 403 `PLATFORM_MCP_TOOL_NOT_PERMITTED`。
   */
  async assertToolAllowed(
    callerId: string,
    bareToolName: string,
  ): Promise<void> {
    const key = `vteam_${bareToolName}`;
    const member = await this.prisma.teamMember.findUnique({
      where: { id: callerId },
      select: {
        agent: {
          select: { id: true, name: true, agentKey: true, policyId: true },
        },
      },
    });
    if (!member?.agent) {
      throw this.notPermitted(
        key,
        `调用方（${callerId}）未绑定可解析的 Agent`,
      );
    }
    const agent = member.agent;
    let resolved: Awaited<
      ReturnType<ExecutionPolicyService['resolveByAgent']>
    >;
    try {
      resolved = await this.executionPolicyService.resolveByAgent({
        policyId: agent.policyId ?? null,
        agentKey: agent.agentKey ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `[mcp] 工具权限解析失败 caller=${callerId} tool=${key}（fail-closed 拒绝）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw this.notPermitted(key, '执行策略解析异常');
    }
    if (!resolved) {
      throw this.notPermitted(
        key,
        `Agent（${agent.name}）未绑定可解析的执行策略（无策略行且非常量内置名）`,
      );
    }
    const effect = resolved.tools?.[key];
    // allow/ask 放行；deny / 未列入 / 非法值一律拒绝（未列出即 deny，与
    // worker guard `isToolAllowed` / `filterToolsMatrix` 语义一致）。
    if (effect !== 'allow' && effect !== 'ask') {
      throw this.notPermitted(
        key,
        `Agent（${agent.name}）的工具矩阵未授权（effect=${effect ?? '未列入'}）`,
        `策略 ${resolved.policyId}`,
      );
    }
  }

  /** 权限门 403（稳定码 `PLATFORM_MCP_TOOL_NOT_PERMITTED`，与归属 403 机器可判别）。 */
  private notPermitted(
    key: string,
    reason: string,
    detail = '',
  ): ForbiddenException {
    return new ForbiddenException({
      code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      message: `工具 ${key} 未获授权：${reason}${detail ? `（${detail}）` : ''}，拒绝调用`,
    });
  }
}
