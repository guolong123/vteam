import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PERSONA_LIBRARY } from '../persona.constants';

/** 工具 effect 单行（14 篇 §3.3：每工具一行 toolAction + effect 三态）。 */
export class ToolEffectDto {
  @ApiProperty({ description: '工具 action（如 bash / github_create_issue / jenkins-*）' })
  @IsString()
  toolAction: string;

  @ApiProperty({
    description: '权限 effect：allow 允许 / ask 每次确认 / deny 禁止',
    enum: ['allow', 'ask', 'deny'],
  })
  @IsString()
  effect: string;
}

/**
 * POST /agents 请求体（09 篇 §3.7：完全自定义 FR-32）。
 * 仅 type=custom 可创建；skillIds/toolEffects 为可选关联，permissionScope 为对象。
 */
export class CreateAgentDto {
  @ApiProperty({ description: 'Agent 名称（自定义角色名）', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({ description: 'Agent 类型（POST 仅支持 custom 创建）', enum: ['custom'] })
  @IsIn(['custom'])
  type: 'custom';

  @ApiPropertyOptional({ description: '角色 key（与前端 task-create data-role 对齐）' })
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
    description: '工具 effect 配置（FR-35/48，写 agent_tool_effects，每工具一行）',
    type: [ToolEffectDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolEffectDto)
  toolEffects?: ToolEffectDto[];

  @ApiPropertyOptional({
    description: '权限范围对象（FR-36，如 {projects:["p1"], write:false, doclibOnly:true}）',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  permissionScope?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '默认模型 id（D7：opencode 模型 id，provider/model 格式，可选自 available-models）',
    example: 'opencode-go/deepseek-v4-flash',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[^\s\/]+\/[^\s\/]+$/, {
    message: 'defaultModelId 需为 provider/model 格式（如 opencode-go/deepseek-v4-flash）',
  })
  defaultModelId?: string;


}
