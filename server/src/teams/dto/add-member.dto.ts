import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * 成员 ⇄ 角色绑定（agent-role-entity todo 7）。
 *
 * `agentId` 与 `roleId` 均可选，但**至少给一个**（service 层校验，缺两者 → 400
 * `MEMBER_AGENT_REQUIRED`）。`roleId` 缺省保持可选 → 只给 `agentId` 的存量请求行为不变。
 *
 * **优先级（与 service 的 resolveMemberBinding 同源，双处注释）**：
 *   显式 `agentId` 恒胜出；只给 `roleId` 时用 `AgentRole.defaultAgentId` 预填 agentId。
 */
export class AddMemberDto {
  @ApiPropertyOptional({
    description:
      '模板 Agent id（与 roleId 至少给一个；两者都给时本字段优先，不被角色默认值覆盖）',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description:
      '岗位角色 id（AgentRole）；给出且未显式给 agentId 时，用角色 defaultAgentId 预填 agentId',
  })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({
    description: '实例别名（缺省 = `<角色中文名>-<seq>`）',
  })
  @IsOptional()
  @IsString()
  alias?: string;

  @ApiPropertyOptional({
    description: '实例持久化工作目录（缺省自动生成）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '实例别名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  alias?: string;

  @ApiPropertyOptional({ description: '实例持久化工作目录' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;

  @ApiPropertyOptional({
    description: '实例覆盖模型 ID（空字符串表示跟随模板）',
  })
  @IsOptional()
  @IsString()
  overrideModelId?: string | null;

  @ApiPropertyOptional({
    description:
      'opencode 原生 agent 名（如 build/plan；空字符串或 null 表示不指定，用 opencode 默认 agent）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  opencodeAgentName?: string | null;

  @ApiPropertyOptional({
    description:
      '岗位角色 id（null/空串清除绑定；给出且未显式给 agentId 时用角色 defaultAgentId 预填 agentId）',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o) => o.roleId !== null)
  @IsString()
  roleId?: string | null;

  @ApiPropertyOptional({
    description:
      '显式覆盖 Agent id（与 roleId 同给时本字段优先；不传则不改 agentId）',
  })
  @IsOptional()
  @IsString()
  agentId?: string;
}
