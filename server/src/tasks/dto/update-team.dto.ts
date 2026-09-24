import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class TeamInstanceInput {
  @ApiPropertyOptional({
    description:
      '模板 Agent id（与 roleId 至少其一；只给 roleId 时用角色默认 Agent 预填，规则见 teams.service resolveMemberBinding）',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description:
      '岗位角色 id（AgentRole）；随成员一并持久化，用于「成员 ⇄ 角色」绑定',
  })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ description: '实例别名' })
  @IsOptional()
  @IsString()
  alias?: string;

  @ApiPropertyOptional({
    description:
      'opencode 原生 agent 选择（显式值恒胜出；未给时用角色默认外部名预填，规则见 teams.service resolveMemberBinding 规则 5）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  opencodeAgentName?: string;

  @ApiPropertyOptional({ description: '实例工作目录' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}

/**
 * POST /tasks/:id/team 请求体（09 篇 §3.4 团队调整，FR-02；角色/实例分离 T2）。
 * addInstances 新增实例（agentId 可重复 = 同一 agent 添加多实例，服务端生成 seq）；
 * removeInstanceIds 按实例 id 移除。两字段均可选，至少提供其一才有实际变更；
 * 全部幂等分支（remove 目标不存在/已移除）时返回当前任务（200 幂等，与状态迁移一致）。
 */
export class UpdateTaskTeamDto {
  @ApiPropertyOptional({
    description: '新增实例列表（agentId 可重复，服务端生成 seq）',
    type: [TeamInstanceInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TeamInstanceInput)
  addInstances?: TeamInstanceInput[];

  @ApiPropertyOptional({
    description: '移除的实例 id 列表（不在团队/已移除者幂等跳过）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeInstanceIds?: string[];
}
