import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PERSONA_LIBRARY } from '../persona.constants';

/**
 * POST /agents 请求体（09 篇 §3.7：完全自定义 FR-32）。
 * 仅 type=custom 可创建；skillIds 为可选关联；权限唯一来源为 policyId 绑定的
 * ExecutionPolicy（effectivePermission 经服务端解析返回，不由 DTO 传入）。
 */
export class CreateAgentDto {
  @ApiProperty({ description: 'Agent 名称（自定义角色名）', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: 'Agent 类型（POST 仅支持 custom 创建）',
    enum: ['custom'],
  })
  @IsIn(['custom'])
  type: 'custom';

  @ApiPropertyOptional({
    description: '角色 key（与前端 task-create data-role 对齐）',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ description: '角色提示词（FR-33）' })
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiPropertyOptional({
    description:
      'Agent 性格（PERSONA_LIBRARY 预设 key：steady/strict/aggressive/conservative/innovative；' +
      '第五维协作风格，不改变权限/工具边界；缺省无性格）',
    enum: Object.keys(PERSONA_LIBRARY),
    example: 'strict',
  })
  @IsOptional()
  @IsIn(Object.keys(PERSONA_LIBRARY))
  persona?: string;

  @ApiPropertyOptional({
    description: '勾选技能 id 列表（FR-34，写 agent_skills）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillIds?: string[];

  @ApiPropertyOptional({
    description:
      '默认模型 id（D7：opencode 模型 id，provider/model 格式，可选自 available-models）',
    example: 'opencode-go/deepseek-v4-flash',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[^\s\/]+\/[^\s\/]+$/, {
    message:
      'defaultModelId 需为 provider/model 格式（如 opencode-go/deepseek-v4-flash）',
  })
  defaultModelId?: string;

  @ApiPropertyOptional({
    description:
      '绑定的 ExecutionPolicy id（角色模板策略 ep_<role>；custom 经 PATCH 改 policyId 生效）',
    example: 'ep_developer',
  })
  @IsOptional()
  @IsString()
  policyId?: string;
}
