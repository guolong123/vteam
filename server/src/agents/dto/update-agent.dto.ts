import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ToolEffectDto } from './create-agent.dto';

/**
 * PATCH /agents/:id 请求体（09 篇 §3.7：FR-33~36/47/48）。
 * skillIds/toolEffects 显式传入时重建关联（deleteMany + create），不传则保持原关联。
 */
export class UpdateAgentDto {
  @ApiPropertyOptional({ description: 'Agent 名称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '角色 key' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ description: '角色提示词（FR-33，作用于后续会话）' })
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiPropertyOptional({
    description: '勾选技能 id 列表（重建 agent_skills 关联）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillIds?: string[];

  @ApiPropertyOptional({
    description: '工具 effect 配置（重建 agent_tool_effects 关联）',
    type: [ToolEffectDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolEffectDto)
  toolEffects?: ToolEffectDto[];

  @ApiPropertyOptional({ description: '权限范围对象（FR-36）', type: Object })
  @IsOptional()
  @IsObject()
  permissionScope?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '默认模型 id（D7：opencode 模型 id，provider/model 格式）',
    example: 'opencode-go/deepseek-v4-flash',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-_.]+\/[a-z0-9-_.]+$/, {
    message: 'defaultModelId 需为 provider/model 格式（如 opencode-go/deepseek-v4-flash）',
  })
  defaultModelId?: string;

  @ApiPropertyOptional({
    description: '首选 worker id（软绑定，可空 null=自动调度；C6）',
    example: 'wkr_0000000001',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.workerId !== null)
  workerId?: string | null;
}