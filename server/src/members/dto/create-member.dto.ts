import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PERSONA_LIBRARY } from '../../agents/persona.constants';
import { MEMBER_PROMPT_MODE, MemberPromptMode } from '../members.constants';

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

  @ApiPropertyOptional({
    description:
      '成员性格（PERSONA_LIBRARY 预设 key：steady/strict/aggressive/conservative/innovative）；' +
      '同一 Agent/岗位的不同成员可有不同表达与协作风格，不改变权限/工具边界；' +
      '非空时优先于 Agent 性格（Agent 列仅作存量回退）',
    enum: Object.keys(PERSONA_LIBRARY),
    example: 'steady',
  })
  @IsOptional()
  @IsIn(Object.keys(PERSONA_LIBRARY))
  persona?: string;

  @ApiPropertyOptional({
    description:
      '成员专属提示词（成员级特殊行为描述，如多个开发者成员各自负责范围不同）；' +
      '与 Agent 岗位职责提示词的组合方式由 promptMode 决定，最长 8000 字',
    maxLength: 8000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  prompt?: string;

  @ApiPropertyOptional({
    description:
      '成员提示词与 Agent 提示词的关系：' +
      'append=在 Agent 岗位职责之上追加【成员专属要求】（默认）；' +
      'override=覆盖 Agent 提示词段',
    enum: Object.values(MEMBER_PROMPT_MODE),
    example: MEMBER_PROMPT_MODE.append,
  })
  @IsOptional()
  @IsIn(Object.values(MEMBER_PROMPT_MODE))
  promptMode?: MemberPromptMode;
}
