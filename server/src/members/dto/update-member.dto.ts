import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PERSONA_LIBRARY } from '../../agents/persona.constants';
import {
  MEMBER_PROMPT_MODE,
  MEMBER_STATUS,
  MemberPromptMode,
} from '../members.constants';

/** PATCH /members/:id 请求体：全部可选，仅更新传入字段。 */
export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '成员名（全局唯一）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '默认岗位 id（AgentRole）' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ description: '执行 Agent id' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ description: '默认模型 id' })
  @IsOptional()
  @IsString()
  defaultModelId?: string;

  @ApiPropertyOptional({ description: '默认 worker 偏好' })
  @IsOptional()
  @IsString()
  preferredWorkerId?: string;

  @ApiPropertyOptional({ description: '成员私有工作目录', maxLength: 255 })
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
    description: '状态：active / disabled',
    enum: ['active', 'disabled'],
  })
  @IsOptional()
  @IsIn([MEMBER_STATUS.active, MEMBER_STATUS.disabled])
  status?: string;

  @ApiPropertyOptional({
    description:
      '成员性格（PERSONA_LIBRARY 预设 key：steady/strict/aggressive/conservative/innovative）；' +
      'null=清除性格；非空时优先于 Agent 性格',
    enum: Object.keys(PERSONA_LIBRARY),
    nullable: true,
    example: 'steady',
  })
  @IsOptional()
  @IsIn(Object.keys(PERSONA_LIBRARY))
  persona?: string | null;

  @ApiPropertyOptional({
    description:
      '成员专属提示词（成员级特殊行为描述）；null=清除；最长 8000 字，' +
      '与 Agent 提示词的关系由 promptMode 决定',
    maxLength: 8000,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  prompt?: string | null;

  @ApiPropertyOptional({
    description:
      '成员提示词与 Agent 提示词的关系：append=追加（默认）/ override=覆盖；' +
      '不支持 null（用 append 复位）',
    enum: Object.values(MEMBER_PROMPT_MODE),
    example: MEMBER_PROMPT_MODE.append,
  })
  // 仅「未传」跳过校验：@IsOptional 会把 null 也放过，而 promptMode 列 NOT NULL，
  // 故用 ValidateIf 只跳过 undefined，null 仍走 @IsIn 报 400。
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(Object.values(MEMBER_PROMPT_MODE))
  promptMode?: MemberPromptMode;
}
