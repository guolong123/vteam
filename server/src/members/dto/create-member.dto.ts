import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /members 请求体（37 篇 §5.1）。
 *
 * roleId 必填（默认岗位）；agentId 缺省取 `role.defaultAgentId`；
 * 模型/worker 为可选默认值，席位可覆盖。
 */
export class CreateMemberDto {
  @ApiPropertyOptional({
    description:
      '成员名（全局唯一；缺省按岗位自动生成，如开发者第 2 位=胡二开）',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiProperty({
    description: '默认岗位 id（AgentRole）',
    example: 'ar_architect',
  })
  @IsString()
  @IsNotEmpty()
  roleId: string;

  @ApiPropertyOptional({
    description:
      '执行 Agent id；缺省取岗位 defaultAgentId（两者皆无 → 400 MEMBER_AGENT_REQUIRED）',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ description: '默认模型 id（席位可覆盖）' })
  @IsOptional()
  @IsString()
  defaultModelId?: string;

  @ApiPropertyOptional({ description: '默认 worker 偏好（席位可覆盖）' })
  @IsOptional()
  @IsString()
  preferredWorkerId?: string;

  @ApiPropertyOptional({
    description: '成员私有工作目录（会话默认 cwd）',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  privateWorkDir?: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
