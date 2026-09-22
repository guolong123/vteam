import { ForbiddenException, Injectable } from '@nestjs/common';
import { capabilityKeyForTool } from '../common/constants/platform-capability.constants';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';

/**
 * 平台工具权限门（opencode-native-permissions-and-fixes todo 3；2026-09-21 role-owned
 * capability model）。
 *
 * `tools/call` 的**能力判定**：调用方成员 → 绑定角色 `roleId` → `AgentRole.capabilities`
 * （业务能力点矩阵）→ 工具裸名映射能力点 → **显式 `false` 则 403，缺失键则放行**
 * （default-allow）。权威在岗位（post），不在执行者（executor）：同一岗位换执行 Agent
 * 不改变平台工具权限；`Agent.policyId` 只喂引擎原生层（`buildAgentPolicies`），与本门无关。
 *
 * 命名契约（todo 1 实证，`CONTRACT-tool-naming-and-identity.md` §1）：服务端收到的是
 * **裸名**（`doclib`），目录键是 `vteam_<action>`；本服务是这条桥接的**唯一**位置
 * （`vteam_${bareToolName}`），调用方不得自带前缀、不得再剥前缀。
 *
 * fail-closed 面（有意收窄）：
 *  - 成员不可解析 / 未绑角色 → 403（Q5：平台不支持无岗位成员）；
 *  - 工具映射不到任何能力点（未知/已下线工具）→ 403（unknown 面拒绝）；
 *  - 角色能力点显式为 `false` → 403。
 * 其余（能力点键缺失）→ 放行，即 default-allow。`tools/list` 仍对每个 Agent 全量
 * （调用时拦截，不在清单处过滤）。
 *
 * **有意不做安全边界**（Q3 = 明确接受）：`vteam-api` / `swagger-mcp` 两个 MCP server
 * 不接受本门约束——它们是同层的独立 MCP 服务，本门只防「误调用」，不是安全边界。
 *
 * 测试性：本服务只依赖「成员 id + 工具裸名」，无 ExecutionPolicy 依赖，可用真实
 * prisma 行做可证伪矩阵判定测试（`platform-mcp.tool-permission.spec.ts`）。
 */
@Injectable()
export class PlatformToolPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 断言调用方（团队成员/实例 id）的岗位能力点允许调用 `bareToolName`。
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
        role: {
          select: { id: true, key: true, capabilities: true },
        },
      },
    });
    if (!member?.role) {
      throw this.notPermitted(
        key,
        `调用方（${callerId}）未绑定岗位（成员必须绑定角色）`,
      );
    }
    const role = member.role;
    const capabilityKey = capabilityKeyForTool(key);
    if (!capabilityKey) {
      // 未知/已下线工具：无能力点可映射 → 一律拒绝（unknown 面 fail-closed）。
      throw this.notPermitted(key, '工具不属于任何平台能力点（未知或已下线）');
    }
    const matrix =
      role.capabilities !== null &&
      typeof role.capabilities === 'object' &&
      !Array.isArray(role.capabilities)
        ? (role.capabilities as Record<string, unknown>)
        : null;
    // 显式 false ⇒ 拒绝；缺失键 ⇒ 允许（default-allow）。
    if (matrix?.[capabilityKey] === false) {
      throw this.notPermitted(
        key,
        `岗位（${role.key}）已拒绝能力点 ${capabilityKey}`,
      );
    }
  }

  /** 权限门 403（稳定码 `PLATFORM_MCP_TOOL_NOT_PERMITTED`，与归属 403 机器可判别）。 */
  private notPermitted(key: string, reason: string): ForbiddenException {
    return new ForbiddenException({
      code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
      message: `工具 ${key} 未获授权：${reason}，拒绝调用`,
    });
  }
}
